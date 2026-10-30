import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { canonicalBytes, canonicalHash, canonicalize, parseStrictJson, sha256 } from './canonical.mjs';
import { assertValid, check, compileOutputSchema, SCHEMAS } from './schemas.mjs';
import { CorruptionError, nowIso, Store } from './store.mjs';
import { INPUT, M1_MAXIMUM_TIMEOUT, PROVIDERS, RETURN, capabilityIssues, contextIdsOf, isExecutable, nodePorts, semanticIssues, structuralIssues, topologicalOrder } from './validate.mjs';
import { ADAPTER_VERSION, defaultAdapters, outputContractText, parseJsonAnswer } from './adapters.mjs';
import { isAlive, killTree, launch, processStartTime } from './processes.mjs';
import { UtilityError, captureFiles, jsonValue, ref, resolvePointer, runUtility, textValue, values as valueHelpers } from './utilities.mjs';
import { loadP5EnrollmentWithHostIdentity, P5_ENROLLMENT_RELATIVE_PATH, P5_EVENT_TYPES, validateP5Contract, verifyP5EnrollmentFileCurrent,
  verifyP5GitBaselineCurrent, prepareP5WorkspaceFromIntent, captureP5VerificationInputs, verifyP5VerificationInputsCurrent,
  sealP5Candidate, verifyP5RunningSourceInventory, verifyP5Receipt, inventoryP5SourceWithHost, p5CandidateId, assertP5VerificationPolicy,
  ProtectedSelfRepairError, verifyP5GitToolIdentity, p5CaptureFailureDisposition, p5CaptureHoldDecision, P5_CAPTURE_HOLD_DELAYS_MS } from './protectedSelfRepair.mjs';
import { installProtectedSelfRepairGate } from './p5Gate.mjs';
// The installed release root (no P5 candidate workspace may overlap it) and its P5 package-layout check.
import { ENGINE_RELEASE_ROOT } from './engineRoot.mjs';
import { readInstalledSourceInventory, verifyP5PackageLayout } from './p5Support.mjs';
import { bindP5GitCandidate, createP5GitCommitIntent, executeP5GitPublication, P5_GIT_POLICIES, p5GitPublicationStatus, prepareP5GitRepositoryFromIntent,
  requestP5GitPublication, verifyP5GitCandidateCurrent } from './p5GitCandidate.mjs';
import { transportSchema } from './transport.mjs';
import { allNodesDeep, bodyPrefix, enclosingLoops, fingerprints, parseInstance, requiredSet, returnSources } from './planning.mjs';
import * as gate from './gate.mjs';
import { installMapRuntime } from './mapRuntime.mjs';
import { installSupervision } from './supervision.mjs';
import { installHostAutonomy } from './hostAutonomy.mjs';
import { installTaskRuntime } from './taskRuntime.mjs';
import { installTaskProcesses } from './taskProcesses.mjs';
import { installJudgeAttention } from './judgeAttention.mjs';
import { installWorkflowJudge } from './workflowJudge.mjs';
import { installLinkedRepair } from './linkedRepair.mjs';
import { afterBarrierWork, crashBeforeIdentityPoint, custodyFaultPoint, custodyTransientFault, installCustody, STOP_FAMILY } from './custody.mjs';
import { deterministicOutcomeId, makeFailureOutcome, normalizeAttemptErrorCode, sameOutcome, sourceForErrorCode } from './failureOutcomes.mjs';
import { shimFailureOf } from './supervisor-client.mjs';
import { StreamRecorder } from './streams.mjs';
import { prepareManagedToolIsolation } from './managed-isolation.mjs';
import { DEFAULT_EFFORT, EFFORT_POLICY_VERSION, resolveEffort } from '../../shared/effort.mjs';
import contextChainExample from '../../docs/examples/m1-context-chain/workflow.json' with { type: 'json' };
import deliveryExample from '../../docs/examples/reference-delivery/workflow.json' with { type: 'json' };
import managedTaskExample from '../../docs/examples/managed-task/workflow.json' with { type: 'json' };

export { parseInstance };

export class ApiError extends Error {
  constructor(status, code, message, details = []) { super(message); this.status = status; this.code = code; this.details = details; }
}

const TERMINAL_RUN = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const ACTIVE_RUN = new Set(['queued', 'running', 'draining', 'waiting_for_user', 'stopping']);
const ACTIVE_SQL = `('queued','running','draining','waiting_for_user','stopping')`;
const TERMINAL_ATTEMPT = new Set(['succeeded', 'failed', 'canceled', 'blocked', 'interrupted', 'reused', 'skipped']);
const DONE_OK = new Set(['succeeded', 'reused']);
const UNSTARTED = new Set(['scheduled', 'waiting']);
const DEFAULT_SETTINGS = { schemaVersion: 1, globalLimit: 3, providerLimits: { codex: 1, claude: 1, antigravity: 1 }, externalRunConfirmation: true };
const LIST_DEFAULT = 50;
const STARTUP_TOLERANCE_MS = 5_000;
const API = 'runtime-api-v2.schema.json';
const API_V3 = 'runtime-api-v3.schema.json';
const API_V4 = 'runtime-api-v4.schema.json';
const CHAT_WORKFLOW = 'context-chat';
const LEGACY_AUTHORITY_POLICY = 'designated-judge/1';
const WORKFLOW_JUDGE_POLICY_VERSION = 'workflow-judge/1';

export function canonicalPath(path) {
  const real = realpathSync.native(resolve(path));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
export const scopedId = (loopInstance, iteration, nodeId) => `${loopInstance}/${iteration}/${nodeId}`;

// M2 run lifecycle as a pure table; the scheduler and the decision fixtures share it.
export function m2Transition(state, event) {
  if (TERMINAL_RUN.has(state)) return 'rejected';
  if (event === 'runtime_restart') return 'interrupted';
  if (event === 'root_stop') return 'stopping';
  const table = {
    'running:attempt_failed': 'draining', 'draining:running_finished': 'waiting_for_user', 'running:idle_with_held_work': 'waiting_for_user',
    'running:all_succeeded': 'succeeded', 'waiting_for_user:retry': 'running', 'waiting_for_user:raise_limit': 'running',
    'waiting_for_user:restart_iteration': 'running', 'waiting_for_user:close': 'failed',
  };
  return table[`${state}:${event}`] || 'rejected';
}

export function loopStep({ iteration, maxIterations, continue: again }) {
  if (!again) return 'finish';
  return iteration >= maxIterations ? 'pause_iteration_limit' : 'next';
}

// Selected-alternative join table (PIPELINE_EXECUTION route section).
export function selectedOutcome(states) {
  const active = states.filter(item => item === 'succeeded' || item === 'running' || item === 'failed').length;
  if (active > 1) return 'contract_error';
  if (states.includes('failed')) return 'recovery';
  if (states.includes('pending') || states.includes('running')) return 'wait';
  return active === 1 ? 'commit' : 'inactive';
}

export function routeCase(cases, selected) {
  const matches = cases.filter(item => canonicalize(item.equals) === canonicalize(selected));
  return matches.length > 1 ? { error: 'contract' } : matches.length ? { caseId: matches[0].id } : { caseId: null };
}

export class Engine {
  constructor({ root, adapters = defaultAdapters, processContainment = 'standalone-best-effort', supervisorGeneration = randomUUID(), runtimeInstanceId = randomUUID(), nodeExecutable = process.execPath, bridgeScript = resolve(import.meta.dirname, '../../mcp/bridge.mjs'), externalRunConfirmationOverride = null, maximumAgentTimeoutSeconds = M1_MAXIMUM_TIMEOUT, detectionTtlMs = 30_000, loopMinuteMs = 60_000, supervisor = null, hostAuthority = null, hostRuntimeGeneration = null, hostPolicyId = null,hostVerificationOnly=false, judgeAttentionEnabled=false, lifecycleHost = null, lifecycleClient = null, custodyHost = null, processCustodyRequired = false } = {}) {
    // Process Custody (PoC) owns CLIs through the Lifecycle Host. A Local Control Host binding has its own run permits, so the
    // two are not combined in this PoC.
    if ((custodyHost || processCustodyRequired) && hostAuthority) throw new Error('Process Custody is not available with a Local Control Host binding in this PoC.');
    this.judgeAttentionEnabled = judgeAttentionEnabled === true;
    // P5 admission is never a configuration switch: it opens only when managed startup loads a valid
    // installation-owned enrollment and decideProtectedSelfRepairAdmission proves its installed authority.
    this.protectedSelfRepairEnrollment = null;
    this.protectedSelfRepairEnrollmentFile = null;
    this.protectedSelfRepairEnrollmentArtifact = null;
    this.protectedSelfRepairUnavailableReason = null;
    this.protectedSelfRepairAdmissionEnabled = false;
    this.protectedSelfRepairAdmissionDecision = null;
    this.protectedSelfRepairRunAdmissions = new WeakSet();
    this.protectedSelfRepairRepairAdmissions = new WeakSet();
    this.protectedSelfRepairAcceptanceAdmissions = new WeakSet();
    this.protectedSelfRepairGateRecords = new WeakSet();
    this.custodyHostPid = null;
    this.store = new Store(root);
    // ADR-0006: outer authority from a Local Control Host, when this runtime is registered with one.
    this.hostAuthority = hostAuthority;
    this.hostRuntimeGeneration = hostRuntimeGeneration;
    this.hostVerificationOnly=hostVerificationOnly;
    this.hostPolicyId = hostPolicyId;
    this.lifecycleHost = lifecycleHost;
    this.lifecycleClient = lifecycleClient;
    // Process Custody state: the Host bridge, this Engine's epoch, why custody is unusable (if it is), and the runs to resume.
    this.custodyHost = custodyHost; this.processCustodyRequired = processCustodyRequired === true;
    this.custodyEpoch = null;
    this.custodyUnavailable = this.processCustodyRequired && !custodyHost
      ? 'Process Custody is required, but no Custody Host bridge is configured.' : null;
    this.custodyResumes = []; this.custodyAbandon = [];
    this.hostAdmissions = new WeakSet();
    this.hostPermitRuns = new Map();
    this.hostRuns = new Map();
    this.hostDeadlines = new Map();
    this.hostReleaseFailures = [];
    this.values = valueHelpers(this.store);
    this.adapters = adapters;
    this.processContainment = processContainment;
    this.supervisorGeneration = supervisorGeneration;
    this.runtimeInstanceId = runtimeInstanceId;
    this.nodeExecutable = resolve(nodeExecutable);
    this.bridgeScript = resolve(bridgeScript);
    // The native supervisor is optional: without one, supervision grants are refused and Stop cannot prove termination.
    this.supervisor = supervisor;
    // The runtime's own liveness is reported on its own clock; a hung runtime stops being reported and its runs are stopped.
    if (supervisor) { this.runtimeHeartbeat = setInterval(() => { void Promise.resolve().then(() => supervisor.runtimeAlive()).catch(() => {}); }, 1000); this.runtimeHeartbeat.unref?.(); }
    this.stopRequests = new Map();
    this.dispatchPaused = new Set();
    this.watchdogs = new Map();
    this.awaitingArm = new Set();
    this.emergencyCredentials = new Map();
    this.externalRunConfirmationOverride = externalRunConfirmationOverride;
    this.maximumAgentTimeoutSeconds = maximumAgentTimeoutSeconds;
    this.detectionTtlMs = detectionTtlMs;
    this.loopMinuteMs = loopMinuteMs;
    this.cursorSecret = randomBytes(32);
    this.runs = new Map();        // runId -> in-memory scheduling state for nonterminal runs
    this.processes = new Map();   // attemptId -> live process record
    this.detections = new Map();
    this.locks = new Set();
    this.recoveryBlocked = null;
    // Processes (pid, and the workspace cwd or null when unknown) that recover() could not confirm ended. Until they end, Custody and delivery
    // treat their workspaces as held.
    this.unconfirmedWorkspaces = [];
    this.closing = false;
  }

  get root() { return this.store.root; }
  on(...args) { return this.store.on(...args); }
  off(...args) { return this.store.off(...args); }
  emit(...args) { return this.store.emit(...args); }

  async initialize({ beforeRecovery } = {}) {
    if (beforeRecovery !== undefined && typeof beforeRecovery !== 'function')
      throw new TypeError('Engine initialize beforeRecovery must be a function.');
    this.reconcileIncidentSpool();
    if (!this.store.get('SELECT * FROM application_settings WHERE singleton = 1')) {
      const artifact = this.store.putJson(DEFAULT_SETTINGS);
      this.store.run('INSERT INTO application_settings(singleton, revision, settings_artifact_id, updated_at) VALUES (1, 1, ?, ?)', artifact.artifactId, nowIso());
    }
    if (!this.store.get('SELECT * FROM runtime_identity WHERE singleton = 1'))
      this.store.run('INSERT INTO runtime_identity(singleton, store_id, created_at) VALUES (1, ?, ?)', randomUUID(), nowIso());
    this.migrateLegacyWorkflowPublications();
    this.store.transaction(() => {
      for (const row of this.store.all("SELECT * FROM workflows WHERE kind = 'user'")) {
        const executable = this.latestExecutableWorkflow(row.id);
        if (executable) this.syncCacheNodeIncarnations(row.id, executable);
      }
      for (const pin of this.store.all('SELECT * FROM cache_pins WHERE incarnation_id IS NULL')) {
        const current = this.store.get('SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND node_id = ? AND active = 1', pin.workflow_id, pin.node_id);
        const incarnationId = current?.incarnation_id || randomUUID();
        if (!current) this.store.run('INSERT OR IGNORE INTO cache_node_incarnations(workflow_id,node_id,incarnation_id,active,created_at,retired_at) VALUES(?,?,?,0,?,?)', pin.workflow_id, pin.node_id, incarnationId, pin.pinned_at, pin.pinned_at);
        this.store.run('UPDATE cache_pins SET incarnation_id = ? WHERE workflow_id = ? AND node_id = ?', incarnationId, pin.workflow_id, pin.node_id);
      }
    });
    this.expireRunRequests();
    if (this.custodyHost) await this.custodyAttach();
    // Managed startup uses this boundary to load Host-verified P5 enrollment before recovery can
    // reconcile or resume a protected run. The callback is optional for legacy and test Engines.
    if (beforeRecovery) await beforeRecovery();
    await this.recover();
    await this.reconcileProtectedSelfRepairPreparations();
    this.reconcileProtectedSelfRepairProjections();
    this.resumeCustodyAttempts();
    if (this.custodyHost) this.startCustodyHoldReconciler();
    else if (this.store.get(`SELECT COUNT(*) AS n FROM custody_workspace_holds WHERE state = 'held'`).n) {
      process.stderr.write('Process Custody is not enabled, but Host-owned processes recorded by an earlier Engine may still run; their workspaces stay held until an Engine with Process Custody reconciles them.\n');
    }
    // ADR-0008: held runs keep their durable state through recover(); reconciliation rebuilds their scheduler state and
    // completes any transition whose durable precondition already holds.
    this.reconcileContinuations();
    this.initializeJudgeAttention();
    this.initializeWorkflowJudge();
  }

  // P5 enrollment is loaded before recovery only after Custody attachment. The Host re-hashes its
  // active package and binds the request to this managed Engine PID; local Git state and the build
  // label are not source provenance.
  async initializeProtectedSelfRepairEnrollment() {
    this.protectedSelfRepairAdmissionEnabled = false;
    this.protectedSelfRepairAdmissionDecision = null;
    this.protectedSelfRepairEnrollment = null;
    this.protectedSelfRepairEnrollmentFile = null;
    this.protectedSelfRepairEnrollmentArtifact = null;
    this.protectedSelfRepairUnavailableReason = null;
    const profileRoot = this.lifecycleHost?.profileRoot;
    if (!profileRoot || !existsSync(join(profileRoot, P5_ENROLLMENT_RELATIVE_PATH))) return false;
    if (!this.lifecycleClient || !this.custodyHost || this.custodyUnavailable || !this.custodyEpoch) {
      this.protectedSelfRepairUnavailableReason = 'P5 enrollment requires the managed Lifecycle Host and an attached Process Custody Host.';
      return false;
    }
    try {
      const runningSourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
      const readers = this.protectedSelfRepairHostReaders();
      const loaded = await loadP5EnrollmentWithHostIdentity({ profileRoot, store: this.store,
        installationId: this.lifecycleHost.installationId, runningSourceRelease, ...readers });
      if (!loaded) return false;
      await verifyP5RunningSourceInventory({ store: this.store, enrollment: loaded.enrollment,
        currentRunningSourceRelease: runningSourceRelease, generation: this.lifecycleHost.generation,
        installedInventory: readInstalledSourceInventory(),
        readBatch: paths => this.lifecycleClient.runningSourceInventory({ pid: process.pid, paths }) });
      this.protectedSelfRepairEnrollment = loaded.enrollment;
      this.protectedSelfRepairEnrollmentFile = loaded;
      this.protectedSelfRepairEnrollmentArtifact = ref(this.store.putJson(loaded.enrollment));
      const decision = await this.decideProtectedSelfRepairAdmission({ enrollment: loaded.enrollment, runningSourceRelease, readers });
      this.protectedSelfRepairAdmissionDecision = decision;
      this.protectedSelfRepairAdmissionEnabled = decision.enabled === true;
      // F9: a publication whose Engine exited mid-flight is reconciled against the remote ref, never blindly repeated.
      if (this.protectedSelfRepairAdmissionEnabled) this.recoverProtectedSelfRepairPublications().catch(() => {});
      if (!decision.enabled) {
        this.protectedSelfRepairUnavailableReason = `p5_admission_refused: ${decision.reasons.join(', ')}`;
        process.stderr.write(`Protected Self-Repair admission stays closed: ${this.protectedSelfRepairUnavailableReason}\n`);
      }
      return true;
    } catch (error) {
      this.protectedSelfRepairUnavailableReason = `${error.code || 'p5_enrollment_unavailable'}: ${error.message}`;
      process.stderr.write(`Protected Self-Repair enrollment was refused: ${this.protectedSelfRepairUnavailableReason}\n`);
      return false;
    }
  }

  /**
   * The only path that opens P5 admission. Every prerequisite is checked against installed, Host-attested
   * state at startup; each later stage still re-verifies its own inputs. A failure keeps admission closed.
   */
  async decideProtectedSelfRepairAdmission({ enrollment, runningSourceRelease, readers }) {
    const reasons = [];
    const check = async (reason, predicate) => {
      try { if (!(await predicate())) reasons.push(reason); }
      catch (error) { reasons.push(`${reason}(${error.code || 'error'})`); }
    };
    await check('runtime_capability', () => enrollment.minimumReaderCapability === 'protected-self-repair-v1');
    // The trusted Gate runs from an attested source layout: the runtime-bootstrap release itself, or the P5 support payload of a
    // bundled desktop release, bound to the running bundle (P5-CLOSURE §5). A desktop release without one keeps P5 closed.
    await check('runtime_package_layout', () => Boolean(verifyP5PackageLayout(runningSourceRelease)));
    // P5-CLOSURE §6 (review R5): a production Self-Repair policy must make the Gate prove the incident on the installed baseline.
    await check('causal_verification', () => {
      this.store.verifyRef(enrollment.verificationPolicy);
      return Boolean(this.store.readJson(enrollment.verificationPolicy.artifactId).causalReproduction);
    });
    await check('host_certainty', () => Boolean(this.lifecycleClient && this.lifecycleHost?.generation && this.custodyHost
      && !this.custodyUnavailable && Number.isSafeInteger(this.custodyEpoch)));
    await check('source_baseline', async () => Boolean(await verifyP5GitBaselineCurrent({ store: this.store, enrollment,
      currentRunningSourceRelease: runningSourceRelease, ...readers })));
    await check('verification_policy', () => {
      this.store.verifyRef(enrollment.verificationPolicy);
      const policy = this.store.readJson(enrollment.verificationPolicy.artifactId);
      assertP5VerificationPolicy(policy);
      return canonicalHash(policy) === enrollment.verificationPolicy.sha256 && policy.harnessClosureDigest === enrollment.harnessClosureDigest;
    });
    for (const [label, publication] of [['parent_publication', enrollment.parentPublication], ['repair_publication', enrollment.repairPublication]]) {
      await check(label, () => {
        const row = this.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p JOIN artifacts a ON a.id = p.snapshot_artifact_id
          WHERE p.id = ? AND p.workflow_id = ? AND p.runnable = 1`, publication.publishedVersionId, publication.workflowId);
        return Boolean(row && row.version === publication.version && row.snapshot_sha256 === publication.snapshotSha256);
      });
    }
    await check('workspace_slot', async () => {
      const row = this.store.get('SELECT * FROM workspaces WHERE id = ?', enrollment.workspace.workspaceId);
      if (!row || resolve(row.cwd).toLowerCase() !== resolve(enrollment.workspace.canonicalRoot).toLowerCase()) return false;
      const identity = await readers.nativeSourceReader({ root: enrollment.workspace.canonicalRoot, include: [], exclude: [], maxFiles: 0, maxBytes: 0 });
      return !identity?.refused && canonicalHash(identity.rootIdentity) === canonicalHash(enrollment.workspace.nativeIdentity);
    });
    return Object.freeze({ enabled: reasons.length === 0, reasons, enrollmentId: enrollment.enrollmentId,
      lifecycleGeneration: this.lifecycleHost?.generation ?? null, engineEpoch: this.custodyEpoch ?? null, decidedAt: nowIso() });
  }

  /**
   * Owner read of the Lifecycle Host's own attestation for this managed Engine and the current P5 admission decision.
   * Installation provisioning records this response verbatim; the Engine never synthesizes a release record.
   */
  async installedSourceRelease() {
    if (!this.lifecycleClient || !this.lifecycleHost?.generation)
      throw new ApiError(409, 'lifecycle_host_unavailable', 'This runtime is not managed by an attesting Lifecycle Host.');
    const release = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
    validateP5Contract('runningSourceRelease', release);
    return { release, lifecycleGeneration: this.lifecycleHost.generation, installationId: this.lifecycleHost.installationId,
      protectedSelfRepair: { enrollmentLoaded: Boolean(this.protectedSelfRepairEnrollment), admissionEnabled: this.protectedSelfRepairAdmissionEnabled === true,
        decision: this.protectedSelfRepairAdmissionDecision, unavailableReason: this.protectedSelfRepairUnavailableReason } };
  }

  /**
   * P5-CLOSURE F9: everything publication needs, re-derived from durable state: the handoff, the enrolled Git tool
   * re-identified through the Host, and the live P5 projection of this Repair Run (an invalidated, stopped or uncertain repair
   * never publishes). The Owner grants publication only through the installation enrollment.
   */
  async protectedSelfRepairPublicationContext(repairRunId) {
    const projection = this.protectedSelfRepairRunProjection(repairRunId);
    if (!projection) throw new ApiError(404, 'not_found', 'The run is not a Protected Self-Repair Repair run.');
    const handoff = this.store.readEvents(repairRunId).find(item => item.type === 'self_repair.handoff_recorded');
    if (!handoff) throw new ApiError(409, 'p5_publication_refused', 'The Repair has no accepted P6 handoff to publish.');
    const enrollment = this.protectedSelfRepairEnrollment;
    const tool = enrollment?.toolIdentities?.find(item => item.name === 'git');
    const handoffValue = this.store.readJson(handoff.payload.record.artifactId);
    if (!tool || canonicalHash(enrollment) !== handoffValue.enrollment?.sha256)
      throw new ApiError(409, 'p5_publication_refused', 'The current installation enrollment does not provide the enrolled Git tool.');
    const readers = this.protectedSelfRepairHostReaders();
    const gitTool = { path: tool.path, sha256: tool.sha256 };
    const identity = await verifyP5GitToolIdentity({ gitTool, nativeToolIdentityReader: readers.nativeToolIdentityReader });
    if (identity.sha256 !== gitTool.sha256) throw new ApiError(409, 'p5_publication_refused', 'The enrolled Git tool identity changed.');
    const eligibility = () => {
      const link = this.logicalRepairLinkForRun(repairRunId);
      if (!link) return { stage: 'held_uncertain', issues: ['link_missing'], parentStopped: true };
      const parent = this.store.get('SELECT state FROM runs WHERE id = ?', link.parent_run_id);
      const parentStopped = ['canceled', 'stopping', 'stopped'].includes(parent?.state) || link.state === 'parent_stopped'
        || link.parent_suspension_state === 'stopped';
      return { ...this.protectedSelfRepairRunProjection(repairRunId), parentStopped };
    };
    return { store: this.store, repairRunId, handoffRef: handoff.payload.record, gitTool,
      appendEvent: event => this.store.appendEvents(repairRunId, [event]),
      verifyCurrent: () => verifyP5GitCandidateCurrent({ store: this.store, candidateRef: handoffValue.candidate,
        nativeSourceReader: readers.nativeSourceReader, nativeToolIdentityReader: readers.nativeToolIdentityReader,
        expectedGitCandidateRef: handoffValue.gitCandidate }), eligibility };
  }

  /**
   * P5-FINAL §8.2 / P5-CLOSURE F9: Owner-requested publication of an accepted repair branch to the enrolled remote. The request
   * only records the durable create-only intent (202); execution continues under the Engine, independent of the connection.
   */
  async publishProtectedSelfRepairBranch(repairRunId) {
    try {
      const context = await this.protectedSelfRepairPublicationContext(repairRunId);
      const admitted = await requestP5GitPublication({ ...context, eligibility: context.eligibility() });
      if (admitted.replay) return { status: 200, body: admitted };
      this.scheduleProtectedSelfRepairPublication(repairRunId, context);
      return { status: 202, body: { ...admitted, publication: this.protectedSelfRepairPublicationStatus(repairRunId) } };
    } catch (error) {
      if (error instanceof ProtectedSelfRepairError) throw new ApiError(409, error.code, error.message);
      throw error;
    }
  }

  /** One executor per Repair at a time; it re-reads the journal, so a duplicate request or restart never pushes twice. */
  scheduleProtectedSelfRepairPublication(repairRunId, context) {
    this.protectedSelfRepairPublications ??= new Map();
    if (this.protectedSelfRepairPublications.has(repairRunId)) return this.protectedSelfRepairPublications.get(repairRunId);
    const task = (async () => {
      try { await executeP5GitPublication({ ...context, currentEligibility: context.eligibility }); }
      catch (error) { process.stderr.write(`Protected Self-Repair publication stays held for reconciliation: ${error.code || 'error'}: ${error.message}\n`); }
      finally { this.protectedSelfRepairPublications.delete(repairRunId); }
    })();
    this.protectedSelfRepairPublications.set(repairRunId, task);
    return task;
  }

  protectedSelfRepairPublicationStatus(repairRunId) {
    if (!this.protectedSelfRepairRunProjection(repairRunId)) throw new ApiError(404, 'not_found', 'The run is not a Protected Self-Repair Repair run.');
    return p5GitPublicationStatus({ store: this.store, repairRunId, executing: this.protectedSelfRepairPublications?.has(repairRunId) === true });
  }

  /** At startup with admission open: reconcile every publication intent that has no recorded result (Engine exited mid-flight). */
  async recoverProtectedSelfRepairPublications() {
    const runs = this.store.all(`SELECT DISTINCT run_id FROM journal_events WHERE event_type = 'self_repair.publication_intent'`);
    for (const { run_id: repairRunId } of runs) {
      try {
        if (p5GitPublicationStatus({ store: this.store, repairRunId }).state !== 'held_uncertain') continue;
        this.scheduleProtectedSelfRepairPublication(repairRunId, await this.protectedSelfRepairPublicationContext(repairRunId));
      } catch (error) { process.stderr.write(`Protected Self-Repair publication recovery deferred for ${repairRunId}: ${error.message}\n`); }
    }
  }

  protectedSelfRepairHostReaders() {
    const generation = this.lifecycleHost?.generation || this.custodyHost?.context?.generation;
    if (!this.custodyHost || typeof this.custodyHost.custody !== 'function' || !generation || !Number.isSafeInteger(this.custodyEpoch))
      throw new ApiError(409, 'p5_host_unavailable', 'P5 requires the current generation and epoch fenced Rust Process Custody Host.');
    return {
      nativeSourceReader: request => this.custodyHost.custody('custody.source_identity', { generation, epoch: this.custodyEpoch, ...request }),
      nativeToolIdentityReader: request => this.custodyHost.custody('custody.tool_identity', { generation, epoch: this.custodyEpoch, ...request }),
      expectedHostPid: this.custodyHostPid, expectedGeneration: generation, expectedEpoch: this.custodyEpoch,
    };
  }

  async verifyProtectedSelfRepairEnrollmentFileCurrent() {
    const file = this.protectedSelfRepairEnrollmentFile;
    if (!file) throw new ApiError(409, 'p5_enrollment_unavailable', 'No installation-owned P5 enrollment file is loaded.');
    return verifyP5EnrollmentFileCurrent({ ...file, ...this.protectedSelfRepairHostReaders() });
  }

  async prepareProtectedSelfRepairParentRunAdmission({ publication, workflow }) {
    const enrollment = this.protectedSelfRepairEnrollment;
    const enrollmentFile = this.protectedSelfRepairEnrollmentFile;
    if (!enrollment || !enrollmentFile || !this.protectedSelfRepairEnrollmentArtifact)
      throw new ApiError(409, 'p5_enrollment_unavailable', this.protectedSelfRepairUnavailableReason || 'No valid installation-owned P5 enrollment is loaded.');
    if (!this.lifecycleClient || !this.lifecycleHost?.generation || !this.custodyHost || this.custodyUnavailable || !this.custodyEpoch)
      throw new ApiError(409, 'p5_host_unavailable', 'P5 Parent admission requires the managed Lifecycle Host and attached Process Custody Host.');
    if (!publication || publication.workflow_id !== enrollment.parentPublication.workflowId
      || publication.id !== enrollment.parentPublication.publishedVersionId || publication.version !== enrollment.parentPublication.version
      || publication.snapshot_sha256 !== enrollment.parentPublication.snapshotSha256
      || workflow.workflowId !== enrollment.parentPublication.workflowId)
      throw new ApiError(409, 'p5_publication_mismatch', 'This P5 Run does not use the exact enrolled Parent publication.');
    const profileMatches = (workflow.judgePolicy?.repairProfiles || []).filter(item => item.selfRepair
      && canonicalHash(item.selfRepair) === canonicalHash(enrollment.profile));
    if (profileMatches.length !== 1)
      throw new ApiError(409, 'p5_profile_mismatch', 'The enrolled Parent publication must contain exactly one Repair profile bound to the enrolled P5 profile artifact.');
    const repairPublication = this.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
      JOIN artifacts a ON a.id = p.snapshot_artifact_id WHERE p.id = ? AND p.workflow_id = ? AND p.runnable = 1`,
      enrollment.repairPublication.publishedVersionId, enrollment.repairPublication.workflowId);
    if (!repairPublication || repairPublication.version !== enrollment.repairPublication.version
      || repairPublication.snapshot_sha256 !== enrollment.repairPublication.snapshotSha256)
      throw new ApiError(409, 'p5_publication_mismatch', 'The enrolled Repair publication is missing or its immutable snapshot changed.');
    try {
      const external = await this.verifyProtectedSelfRepairEnrollmentFileCurrent();
      if (canonicalHash(external) !== canonicalHash(enrollment))
        throw Object.assign(new Error('The installed P5 enrollment changed.'), { code: 'p5_enrollment_changed' });
      const currentRunningSourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
      const readers = this.protectedSelfRepairHostReaders();
      const currentBaseline = await verifyP5GitBaselineCurrent({ store: this.store, enrollment, currentRunningSourceRelease, ...readers });
      const admission = Object.freeze({ kind: 'p5-parent-run-admission', enrollment, enrollmentRef: this.protectedSelfRepairEnrollmentArtifact,
        baseline: currentBaseline, publication: enrollment.parentPublication, profile: enrollment.profile,
        runningSourceRelease: enrollment.runningSourceRelease, lifecycleGeneration: this.lifecycleHost.generation });
      this.protectedSelfRepairRunAdmissions.add(admission);
      return admission;
    } catch (error) {
      throw new ApiError(409, error.code || 'p5_admission_unavailable', `Protected Self-Repair admission was refused: ${error.message}`);
    }
  }

  protectedSelfRepairJournalRecordRef(runId, type) {
    const events = this.store.readEvents(runId).filter(item => item.type === type);
    if (events.length !== 1 || !events[0].payload?.record) return null;
    const recordRef = events[0].payload.record;
    this.store.verifyRef(recordRef);
    return recordRef;
  }

  async prepareProtectedSelfRepairRepairAdmission({ state, attempt, attention, context, decision }) {
    if (decision?.action?.type !== 'request_repair') return null;
    const parent = this.requireRun(state.id);
    const parentWorkflow = this.store.readJson(parent.workflow_snapshot_artifact_id);
    const profile = parentWorkflow.judgePolicy?.repairProfiles?.find(item => item.profileId === decision.action.repairProfileId);
    if (!profile?.selfRepair) return null;
    if (this.protectedSelfRepairAdmissionEnabled !== true)
      throw new ApiError(409, 'p5_admission_unavailable', 'P5 Repair remains fail-closed until candidate capture, trusted verification, atomic acceptance and recovery are all enabled. No Repair was opened.');
    const enrollment = this.protectedSelfRepairEnrollment;
    const enrollmentFile = this.protectedSelfRepairEnrollmentFile;
    const enrollmentRef = this.protectedSelfRepairEnrollmentArtifact;
    if (!enrollment || !enrollmentFile || !enrollmentRef || !this.lifecycleClient || !this.lifecycleHost?.generation
      || !this.custodyHost || this.custodyUnavailable || !Number.isSafeInteger(this.custodyEpoch))
      throw new ApiError(409, 'p5_enrollment_unavailable', this.protectedSelfRepairUnavailableReason || 'The installed P5 enrollment and current Lifecycle/Custody Host proof are unavailable.');
    if (context?.kind !== 'failure' || context.incidentId !== attention?.incidentId || attention?.runId !== parent.id
      || attention?.judgeAttemptId !== attempt?.id || !parentWorkflow.capabilities?.includes('protected-self-repair-v1')
      || parent.published_version_id !== enrollment.parentPublication.publishedVersionId
      || parentWorkflow.workflowId !== enrollment.parentPublication.workflowId
      || profile.selfRepair.artifactId !== enrollment.profile.artifactId || profile.selfRepair.sha256 !== enrollment.profile.sha256
      || profile.repairWorkflowId !== enrollment.repairPublication.workflowId
      || profile.repairPublishedVersion !== enrollment.repairPublication.version
      || profile.repairWorkflowSnapshotSha256 !== enrollment.repairPublication.snapshotSha256
      || profile.repairWorkspaceId !== enrollment.workspace.workspaceId
      || profile.acceptanceMode !== 'judge_post_execution')
      throw new ApiError(409, 'p5_repair_profile_mismatch', 'The exact P4 request, enrolled Parent, P5 profile and Repair publication do not agree.');
    const targetOutcomes = (context.outcomes || []).filter(item => item.outcome?.nodeInstanceId === profile.failedNodeInstanceId);
    if (targetOutcomes.length !== 1)
      throw new ApiError(409, 'p5_incident_outcome_mismatch', 'P5 requires exactly one current P3 outcome for its enrolled failed node.');
    const enrolledProfile = this.store.readJson(enrollment.profile.artifactId);
    const capturedInputs = captureP5VerificationInputs({ store: this.store, enrollment, profile: enrolledProfile,
      parentRunId: parent.id, incidentId: attention.incidentId, outcome: targetOutcomes[0].outcome });
    this.store.verifyRef(profile.selfRepair);
    const sourceBindingRef = this.protectedSelfRepairJournalRecordRef(parent.id, 'self_repair.source_bound');
    if (!sourceBindingRef) throw new ApiError(409, 'p5_source_binding_missing', 'The Parent Run has no unique, durable P5 source binding.');
    const sourceBinding = this.store.readJson(sourceBindingRef.artifactId);
    validateP5Contract('sourceBinding', sourceBinding);
    const parentSnapshot = this.store.artifactRow(parent.workflow_snapshot_artifact_id);
    if (sourceBinding.parentRunId !== parent.id || sourceBinding.parentSnapshot.artifactId !== parentSnapshot.id
      || sourceBinding.parentSnapshot.sha256 !== parentSnapshot.sha256 || sourceBinding.enrollmentId !== enrollment.enrollmentId
      || sourceBinding.baselineId !== enrollment.baselineId || sourceBinding.parentPublication.publishedVersionId !== parent.published_version_id
      || sourceBinding.profile.artifactId !== enrollment.profile.artifactId || sourceBinding.profile.sha256 !== enrollment.profile.sha256)
      throw new ApiError(409, 'p5_source_binding_mismatch', 'The durable Parent source binding does not match this P4/P2 request.');
    try {
      const installed = await this.verifyProtectedSelfRepairEnrollmentFileCurrent();
      if (canonicalHash(installed) !== canonicalHash(enrollment))
        throw Object.assign(new Error('The installed P5 enrollment changed.'), { code: 'p5_enrollment_changed' });
      const currentRunningSourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
      const readers = this.protectedSelfRepairHostReaders();
      const currentBaseline = await verifyP5GitBaselineCurrent({ store: this.store, enrollment, currentRunningSourceRelease, ...readers });
      const admission = Object.freeze({ kind: 'p5-repair-run-admission', parentRunId: parent.id, parentPublicationId: parent.published_version_id,
        parentSnapshot: { artifactId: parentSnapshot.id, sha256: parentSnapshot.sha256 }, decisionDigest: canonicalHash(decision),
        judgeAttemptId: attempt.id, attentionKey: attention.attentionKey, incidentId: attention.incidentId, profileId: profile.profileId,
        profileDigest: canonicalHash(profile), enrollment, enrollmentRef, sourceBindingRef, baseline: currentBaseline,
        verificationInputsRef: capturedInputs.artifact, outcomeId: targetOutcomes[0].outcome.outcomeId,
        outcomeRevision: targetOutcomes[0].outcome.revision, outcomeDigest: canonicalHash(targetOutcomes[0].outcome),
        lifecycleGeneration: this.lifecycleHost.generation });
      this.protectedSelfRepairRepairAdmissions.add(admission);
      return admission;
    } catch (error) {
      throw new ApiError(409, error.code || 'p5_admission_unavailable', 'Protected Self-Repair P2 admission was refused: ' + error.message);
    }
  }

  assertProtectedSelfRepairRepairAdmission(admission, { parentRunId, profile, attention, decision, context }) {
    const parent = this.store.get('SELECT * FROM runs WHERE id = ?', parentRunId);
    const parentSnapshot = parent && this.store.artifactRow(parent.workflow_snapshot_artifact_id);
    const targetOutcomes = (context?.outcomes || []).filter(item => item.outcome?.nodeInstanceId === profile?.failedNodeInstanceId);
    if (!admission || !this.protectedSelfRepairRepairAdmissions.has(admission) || admission.kind !== 'p5-repair-run-admission'
      || admission.parentRunId !== parentRunId || admission.profileId !== profile?.profileId
      || admission.profileDigest !== canonicalHash(profile) || admission.attentionKey !== attention?.attentionKey
      || admission.incidentId !== attention?.incidentId || admission.decisionDigest !== canonicalHash(decision)
      || admission.judgeAttemptId !== attention?.judgeAttemptId || !parent || admission.parentPublicationId !== parent.published_version_id
      || !parentSnapshot || admission.parentSnapshot.artifactId !== parentSnapshot.id || admission.parentSnapshot.sha256 !== parentSnapshot.sha256
      || !admission.verificationInputsRef || targetOutcomes.length !== 1 || admission.outcomeId !== targetOutcomes[0].outcome.outcomeId
      || admission.outcomeRevision !== targetOutcomes[0].outcome.revision || admission.outcomeDigest !== canonicalHash(targetOutcomes[0].outcome)
      || admission.enrollment?.enrollmentId !== this.protectedSelfRepairEnrollment?.enrollmentId)
      throw new ApiError(409, 'p5_admission_invalid', 'P5 P2 requires the exact Engine-issued enrollment, Parent, Judge Attempt and Repair decision admission.');
    this.store.verifyRef(admission.verificationInputsRef);
    const inputs = this.store.readJson(admission.verificationInputsRef.artifactId);
    validateP5Contract('verificationInputs', inputs);
    if (inputs.incidentId !== attention.incidentId || inputs.outcomeId !== admission.outcomeId
      || inputs.outcomeRevision !== admission.outcomeRevision
      || canonicalHash(inputs.verificationPolicy) !== canonicalHash(admission.enrollment.verificationPolicy))
      throw new ApiError(409, 'p5_verification_inputs_stale', 'P5 pre-captured incident inputs no longer match the current Judge attention and P3 outcome.');
    const outcomeRow = this.store.get('SELECT outcome_json FROM failure_outcomes WHERE outcome_id = ? AND run_id = ?', admission.outcomeId, parentRunId);
    if (!outcomeRow) throw new ApiError(409, 'p5_verification_inputs_stale', 'The exact P3 outcome row disappeared before the P2 transaction.');
    const outcome = parseStrictJson(outcomeRow.outcome_json);
    if (canonicalHash(outcome) !== admission.outcomeDigest || canonicalHash(outcome) !== canonicalHash(targetOutcomes[0].outcome))
      throw new ApiError(409, 'p5_verification_inputs_stale', 'The persisted P3 outcome changed before the P2 transaction.');
    const enrolledProfile = this.store.readJson(admission.enrollment.profile.artifactId);
    try { verifyP5VerificationInputsCurrent({ store: this.store, enrollment: admission.enrollment, profile: enrolledProfile, parentRunId, inputs }); }
    catch (error) { throw new ApiError(409, error.code || 'p5_verification_inputs_stale', error.message); }
    return admission;
  }

  async prepareProtectedSelfRepairAcceptanceAdmission({ state, attempt, attention, context, decision, evidence }) {
    if (decision?.action?.type !== 'accept_repair' || !context?.p5Review) return null;
    const fail = (code, message) => { throw new ApiError(409, code, message); };
    const link = context.link;
    const p5Review = context.p5Review;
    if (this.protectedSelfRepairAdmissionEnabled !== true)
      fail('p5_acceptance_unavailable', 'P5 acceptance remains fail-closed until the complete lifecycle and recovery proofs are enabled.');
    const projection = this.protectedSelfRepairRunProjection?.(state.id);
    if (!projection || projection.issues.length || projection.stage !== 'judge_pending')
      fail('p5_projection_unavailable', 'P5 acceptance requires an intact journal projection with the exact verified candidate pending its designated Repair Judge.');
    if (!link || link.repair_run_id !== state.id || link.state !== 'open' || link.decision_status !== 'pending'
      || link.acceptance_mode !== 'judge_post_execution' || !this.logicalRepairLinkIntact(link)
      || attention?.runId !== state.id || attention?.judgeAttemptId !== attempt?.id
      || context.kind !== 'repair_approval')
      fail('p5_acceptance_stale', 'P5 acceptance requires the exact open P2 link and its designated Repair Judge Attempt.');
    const parent = this.store.get('SELECT * FROM runs WHERE id = ?', link.parent_run_id);
    if (!parent || ['stopping', 'succeeded', 'failed', 'canceled', 'interrupted'].includes(parent.state)
      || !['suspension_requested', 'suspended_for_repair'].includes(link.parent_suspension_state))
      fail('p5_acceptance_stale', 'Parent Stop or a changed P2 suspension blocks P5 acceptance.');
    if (!this.lifecycleClient || !this.lifecycleHost?.generation || !this.custodyHost || this.custodyUnavailable
      || !Number.isSafeInteger(this.custodyEpoch) || !this.protectedSelfRepairEnrollmentFile
      || !this.protectedSelfRepairEnrollmentArtifact || !this.protectedSelfRepairEnrollment)
      fail('p5_host_unavailable', this.protectedSelfRepairUnavailableReason || 'P5 acceptance requires the current enrolled Lifecycle and Custody Hosts.');
    if (this.store.readEvents(state.id).some(item => item.type === 'self_repair.candidate_invalidated'))
      fail('p5_candidate_invalidated', 'A durable P5 invalidation already revokes this candidate.');
    if (!this.workflowJudgeP5ReviewDelivered(state, attention, evidence, p5Review))
      fail('p5_review_delivery_missing', 'The exact complete P5 review dossier was not delivered to the current Judge Attempt.');
    const deliveryLineage = this.workflowJudgeP5ReviewDeliveryLineage(state, attention, evidence, p5Review);
    if (!deliveryLineage) fail('p5_review_delivery_missing', 'P5 review delivery has no verifiable Judge event lineage.');

    const enrollment = this.protectedSelfRepairEnrollment;
    const invalidateCandidate = reason => this.store.transaction(() =>
      this.invalidateProtectedSelfRepairCandidateInTransaction?.(link, reason));
    try {
      const installed = await this.verifyProtectedSelfRepairEnrollmentFileCurrent();
      if (canonicalHash(installed) !== canonicalHash(enrollment))
        throw Object.assign(new Error('The installed P5 enrollment changed.'), { code: 'p5_enrollment_changed' });
      const currentRunningSourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
      const readers = this.protectedSelfRepairHostReaders();
      await verifyP5GitBaselineCurrent({ store: this.store, enrollment, currentRunningSourceRelease, ...readers });
      await verifyP5RunningSourceInventory({ store: this.store, enrollment, currentRunningSourceRelease,
        generation: this.lifecycleHost.generation, installedInventory: readInstalledSourceInventory(),
        readBatch: paths => this.lifecycleClient.runningSourceInventory({ pid: process.pid, paths }) });

      const candidate = p5Review.candidate;
      const receipt = p5Review.receipt;
      let currentGitVerification = null;
      let gitEligibilityCheckedAt = null;
      this.store.verifyRef(p5Review.candidateRef);
      this.store.verifyRef(p5Review.receiptRef);
      verifyP5Receipt(receipt, { store: this.store, candidateRef: p5Review.candidateRef,
        gateAttemptId: receipt.gateAttemptId, terminalEvidenceRef: receipt.terminalEvidence });
      if (P5_GIT_POLICIES.includes(enrollment.gitCandidatePolicy)) {
        if (!candidate.gitCandidate) fail('p5_git_candidate_missing', 'The enrolled P5 policy requires an immutable Git candidate before approval.');
        currentGitVerification = await verifyP5GitCandidateCurrent({ store: this.store, candidateRef: p5Review.candidateRef,
          nativeSourceReader: readers.nativeSourceReader, nativeToolIdentityReader: readers.nativeToolIdentityReader,
          expectedGitCandidateRef: candidate.gitCandidate });
        gitEligibilityCheckedAt = nowIso();
      }
      let workspaceMatches = false;
      try {
        workspaceMatches = candidate.repairRunId === state.id && candidate.parentRunId === link.parent_run_id
          && candidate.linkId === link.id && candidate.incidentId === link.incident_id
          && candidate.enrollment?.artifactId === this.protectedSelfRepairEnrollmentArtifact.artifactId
          && candidate.enrollment?.sha256 === this.protectedSelfRepairEnrollmentArtifact.sha256
          && candidate.workspace.workspaceId === enrollment.workspace.workspaceId
          && candidate.workspace.allocationId === enrollment.workspace.allocationId
          && canonicalPath(candidate.workspace.canonicalRoot) === canonicalPath(enrollment.workspace.canonicalRoot)
          && canonicalPath(candidate.workspace.sourceRoot) === canonicalPath(resolve(candidate.workspace.canonicalRoot, 'source'));
      } catch { workspaceMatches = false; }
      if (!workspaceMatches) {
        invalidateCandidate('authorization_changed');
        fail('p5_candidate_binding_mismatch', 'P5 candidate identities no longer match the enrolled workspace, P2 link and current Repair.');
      }

      const sourceManifest = this.store.readJson(candidate.sourceManifest.artifactId);
      const expectedEntries = sourceManifest.entries.map(({ artifact: _artifact, ...entry }) => entry);
      const executableModes = new Map(expectedEntries.map(entry => [entry.path, entry.executable]));
      let currentCandidate;
      try {
        currentCandidate = await inventoryP5SourceWithHost(candidate.workspace.sourceRoot, {
          nativeSourceReader: readers.nativeSourceReader,
          maxFiles: enrollment.budgets.maxSourceFiles,
          maxBytes: enrollment.budgets.maxSourceBytes,
          include: ['**'], exclude: candidate.gitCandidate ? ['.git/**'] : [], executableFor: path => executableModes.get(path) ?? false });
      } catch (error) {
        const reason = ['p5_host_unavailable', 'p5_native_identity_unavailable', 'p5_native_identity_mismatch'].includes(error.code)
          ? 'host_uncertain' : 'source_drift';
        invalidateCandidate(reason);
        fail('p5_candidate_source_unavailable', `The current candidate source could not be proven and its eligibility was revoked: ${error.message}`);
      }
      const captureEvidence = this.store.readJson(candidate.sourceCaptureEvidence.artifactId);
      if (currentCandidate.sourceDigest !== candidate.candidateSourceDigest
        || canonicalHash(currentCandidate.entries) !== canonicalHash(expectedEntries)
        || canonicalHash(currentCandidate.nativeEvidence.rootIdentity) !== canonicalHash(captureEvidence.rootIdentity)) {
        invalidateCandidate('source_drift');
        fail('p5_candidate_source_drift', 'The live candidate source no longer matches the sealed candidate and was durably invalidated.');
      }
      const currentEligibility = Object.freeze({ eligible: true, revision: 1,
        checkedAt: gitEligibilityCheckedAt ?? nowIso(), stage: 'p5_acceptance',
        candidateSourceDigest: candidate.candidateSourceDigest,
        ...(currentGitVerification ? { gitCandidate: candidate.gitCandidate,
          repairBranch: currentGitVerification.gitCandidate.git.repairBranch,
          candidateCommit: currentGitVerification.candidateCommit,
          candidateTree: currentGitVerification.candidateTree,
          storageSnapshotDigest: currentGitVerification.storageSnapshotDigest } : {}) });
      const authRow = this.store.artifactRow(link.authorization_artifact_id);
      if (!authRow?.sha256) fail('p5_authorization_missing', 'The exact P2 authorization artifact is unavailable.');
      const admission = Object.freeze({ kind: 'p5-repair-acceptance-admission', repairRunId: state.id,
        parentRunId: link.parent_run_id, linkId: link.id, incidentId: link.incident_id,
        judgeAttemptId: attempt.id, attentionKey: attention.attentionKey, decisionDigest: canonicalHash(decision),
        candidateRef: p5Review.candidateRef, candidateId: candidate.candidateId,
        candidateSourceDigest: candidate.candidateSourceDigest, receiptRef: p5Review.receiptRef,
        currentEligibility,
        receiptId: receipt.receiptId, gateAttemptId: receipt.gateAttemptId,
        p2Authorization: { artifactId: link.authorization_artifact_id, sha256: authRow.sha256 },
        sourceIntegrityRevision: p5Review.sourceIntegrityRevision, retentionRevision: p5Review.retentionRevision,
        requiredReviewSetDigest: p5Review.dossier.requiredReviewSetDigest,
        reviewDelivery: { attentionKey: attention.attentionKey, evidenceArtifact: attention.evidenceArtifact,
          expansionArtifact: evidence.expandedEvidence.artifact, ...deliveryLineage },
        lifecycleGeneration: this.lifecycleHost.generation, engineEpoch: this.custodyEpoch });
      this.protectedSelfRepairAcceptanceAdmissions.add(admission);
      return admission;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(409, error.code || 'p5_acceptance_unavailable', 'P5 Repair acceptance was refused: ' + error.message);
    }
  }

  assertProtectedSelfRepairAcceptanceAdmission(admission, { state, attempt, attention, context, decision, evidence }) {
    const link = context?.link;
    const p5Review = context?.p5Review;
    const deliveryLineage = p5Review && this.workflowJudgeP5ReviewDeliveryLineage(state, attention, evidence, p5Review);
    const expectedDelivery = deliveryLineage ? { attentionKey: attention.attentionKey, evidenceArtifact: attention.evidenceArtifact,
      expansionArtifact: evidence?.expandedEvidence?.artifact, ...deliveryLineage } : null;
    const authRow = link && this.store.artifactRow(link.authorization_artifact_id);
    if (!admission || !this.protectedSelfRepairAcceptanceAdmissions.has(admission)
      || admission.kind !== 'p5-repair-acceptance-admission' || decision?.action?.type !== 'accept_repair'
      || admission.repairRunId !== state.id || admission.parentRunId !== link?.parent_run_id
      || admission.linkId !== link?.id || admission.incidentId !== link?.incident_id
      || admission.judgeAttemptId !== attempt?.id || admission.attentionKey !== attention?.attentionKey
      || admission.decisionDigest !== canonicalHash(decision) || !p5Review
      || canonicalHash(admission.candidateRef) !== canonicalHash(p5Review.candidateRef)
      || admission.candidateId !== p5Review.candidate.candidateId
      || admission.candidateSourceDigest !== p5Review.candidate.candidateSourceDigest
      || admission.currentEligibility?.eligible !== true
      || admission.currentEligibility?.stage !== 'p5_acceptance'
      || admission.currentEligibility?.candidateSourceDigest !== p5Review.candidate.candidateSourceDigest
      || canonicalHash(admission.currentEligibility.gitCandidate ?? null) !== canonicalHash(p5Review.candidate.gitCandidate ?? null)
      || canonicalHash(admission.receiptRef) !== canonicalHash(p5Review.receiptRef)
      || admission.receiptId !== p5Review.receipt.receiptId || admission.gateAttemptId !== p5Review.receipt.gateAttemptId
      || admission.sourceIntegrityRevision !== p5Review.sourceIntegrityRevision
      || admission.retentionRevision !== p5Review.retentionRevision
      || admission.requiredReviewSetDigest !== p5Review.dossier.requiredReviewSetDigest
      || canonicalHash(admission.reviewDelivery) !== canonicalHash(expectedDelivery)
      || !authRow?.sha256 || admission.p2Authorization.artifactId !== link.authorization_artifact_id
      || admission.p2Authorization.sha256 !== authRow.sha256
      || admission.lifecycleGeneration !== this.lifecycleHost?.generation
      || admission.engineEpoch !== this.custodyEpoch
      || !this.workflowJudgeP5ReviewDelivered(state, attention, evidence, p5Review)
      || link.state !== 'open' || link.decision_status !== 'pending'
      || this.store.readEvents(state.id).some(item => item.type === 'self_repair.candidate_invalidated'))
      throw new ApiError(409, 'p5_acceptance_admission_invalid', 'P5 acceptance lost its exact Engine-issued candidate, receipt, review delivery or P2 binding before commit.');
    return admission;
  }

  async captureProtectedSelfRepairDeveloperCandidate({ state, node, attempt, workspace, binding, record, outcome, current }) {
    const link = this.logicalRepairLinkForRun(state.id);
    const authorization = link && this.parentRepairAuthorization(link);
    if (!authorization?.profile?.selfRepair) return null;
    const fail = (code, message) => { throw new ApiError(409, code, message); };
    if (link.state !== 'open' || link.repair_run_id !== state.id || !this.logicalRepairLinkIntact(link, this.store.get('SELECT * FROM runs WHERE id = ?', state.id)))
      fail('p5_candidate_authorization_invalid', 'P5 candidate capture requires the exact intact, open P2 Repair link.');
    if (this.protectedSelfRepairAdmissionEnabled !== true)
      fail('p5_admission_unavailable', 'P5 candidate capture is unavailable while the complete protected lifecycle remains fail-closed.');
    if (!this.protectedSelfRepairEnrollment || !this.protectedSelfRepairEnrollmentArtifact || !this.protectedSelfRepairEnrollmentFile
      || canonicalHash(authorization.p5Enrollment) !== canonicalHash(this.protectedSelfRepairEnrollmentArtifact))
      fail('p5_enrollment_unavailable', 'P5 candidate capture requires the exact currently loaded installation enrollment.');
    for (const ref of [authorization.selfRepairProfile, authorization.p5Enrollment, authorization.p5SourceBinding, authorization.verificationInputs])
      this.store.verifyRef(ref);
    const profile = this.store.readJson(authorization.selfRepairProfile.artifactId);
    const enrollment = this.protectedSelfRepairEnrollment;
    validateP5Contract('profile', profile);
    validateP5Contract('enrollment', enrollment);
    if (profile.kind !== 'ProtectedSelfRepairProfile' || node.id !== profile.developerNodeId) return null;
    if (node.type !== 'agent' || binding || record.mapped || record.taskExecutionId || record.loops.length !== 0
      || node.config.contextId || !state.workflow.capabilities?.includes('protected-self-repair-v1'))
      fail('p5_developer_execution_unsupported', 'The enrolled P5 Developer must be one top-level, context-free Agent Attempt.');
    const p2Profile = authorization.profile;
    if (p2Profile.selfRepair.artifactId !== enrollment.profile.artifactId || p2Profile.selfRepair.sha256 !== enrollment.profile.sha256
      || authorization.repairRunId !== state.id || authorization.parentRunId !== link.parent_run_id
      || authorization.incidentId !== link.incident_id || authorization.repairWorkspaceId !== enrollment.workspace.workspaceId
      || !authorization.outcomeId || !Number.isSafeInteger(authorization.outcomeRevision))
      fail('p5_candidate_authorization_invalid', 'The P2 Repair authorization differs from the enrolled P5 profile, source, incident or workspace.');
    const priorCandidates = this.store.readEvents(state.id).filter(item => item.type === 'self_repair.candidate_captured');
    if (priorCandidates.length) fail('p5_candidate_already_captured', 'P5 permits only one sealed candidate for this P2 Repair link.');
    const events = this.store.readEvents(state.id);
    const intents = events.filter(item => item.type === 'self_repair.preparation_intent');
    const preparations = events.filter(item => item.type === 'self_repair.workspace_prepared');
    if (intents.length !== 1 || preparations.length !== 1 || !intents[0].payload?.record || !preparations[0].payload?.record)
      fail('p5_workspace_not_prepared', 'P5 candidate capture requires one durable preparation intent and one matching Host-verified prepared record.');
    const intentRef = intents[0].payload.record, preparedRef = preparations[0].payload.record;
    this.store.verifyRef(intentRef); this.store.verifyRef(preparedRef);
    const intent = this.store.readJson(intentRef.artifactId);
    const prepared = this.store.readJson(preparedRef.artifactId);
    if (intent.parentRunId !== link.parent_run_id || intent.repairRunId !== state.id || intent.linkId !== link.id
      || canonicalHash(intent.workspace) !== canonicalHash(enrollment.workspace)
      || canonicalHash(intent.enrollment) !== canonicalHash(authorization.p5Enrollment)
      || canonicalHash(intent.sourceBinding) !== canonicalHash(authorization.p5SourceBinding)
      || canonicalHash(intent.verificationInputs) !== canonicalHash(authorization.verificationInputs)
      || prepared.kind !== 'ProtectedSelfRepairWorkspacePreparation'
      || prepared.intent.artifactId !== intentRef.artifactId || prepared.intent.sha256 !== intentRef.sha256
      || prepared.workspaceRoot !== enrollment.workspace.canonicalRoot
      || prepared.sourceRoot !== resolve(enrollment.workspace.canonicalRoot, 'source')
      || canonicalHash(prepared.workspaceIdentity) !== canonicalHash(enrollment.workspace.nativeIdentity)
      || prepared.baselineId !== enrollment.baselineId || prepared.sourceDigest !== enrollment.effectiveSourceDigest)
      fail('p5_workspace_preparation_mismatch', 'The prepared workspace is not bound to this exact enrolled P2 authorization.');
    const verificationInputs = this.store.readJson(authorization.verificationInputs.artifactId);
    try { verifyP5VerificationInputsCurrent({ store: this.store, enrollment, profile,
      parentRunId: link.parent_run_id, inputs: verificationInputs }); }
    catch (error) { fail(error.code || 'p5_verification_input_stale', error.message); }
    const sourceBindingRef = this.protectedSelfRepairJournalRecordRef(link.parent_run_id, 'self_repair.source_bound');
    if (!sourceBindingRef || canonicalHash(sourceBindingRef) !== canonicalHash(authorization.p5SourceBinding))
      fail('p5_source_binding_missing', 'P5 candidate capture requires the exact Parent source-binding event.');
    const sourceBinding = this.store.readJson(sourceBindingRef.artifactId);
    const installed = await this.verifyProtectedSelfRepairEnrollmentFileCurrent();
    if (canonicalHash(installed) !== canonicalHash(enrollment))
      fail('p5_enrollment_changed', 'The installed P5 enrollment changed before Developer candidate capture.');
      const currentRunningSourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
    const readers = this.protectedSelfRepairHostReaders();
    const currentBaseline = await verifyP5GitBaselineCurrent({ store: this.store, enrollment, currentRunningSourceRelease, ...readers });

    const custody = this.custodyBindingOf(attempt.id);
    const child = record.child;
    const status = child?.terminalStatus;
    const processCreationIdentity = `custody:${status?.processCreationTime}`;
    if (!custody || custody.custody_id !== status?.custodyId || !child?.custody || status?.attemptId !== attempt.id
      || status?.runId !== state.id || status?.terminal !== true || status?.processTreeEnded !== true
      || status?.spoolComplete !== true || status?.tailGapPossible === true || status?.state !== 'exited'
      || status?.exitCode !== outcome.code || status?.processId !== current.process_id
      || current.process_start_identity !== processCreationIdentity || status?.invocationDigest !== child.invocationDigest
      || status?.executableSha256 !== child.executableSha256
      || status?.stdoutAcked !== status?.stdoutDurable || status?.stderrAcked !== status?.stderrDurable)
      fail('p5_developer_terminal_unproven', 'P5 requires the exact Host terminal record, process creation identity, ended tree and complete acknowledged spool.');
    if (!Number.isSafeInteger(this.custodyEpoch) || !this.lifecycleHost?.generation)
      fail('p5_host_unavailable', 'The P5 Developer terminal record is not attached to the current Lifecycle Host generation and Custody epoch.');
    const terminalEvidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairDeveloperTerminalEvidence', runId: state.id,
      attemptId: attempt.id, custodyId: custody.custody_id, lifecycleGeneration: this.lifecycleHost.generation, engineEpoch: this.custodyEpoch,
      processId: status.processId, processCreationTime: status.processCreationTime, invocationDigest: status.invocationDigest,
      executable: status.executable, executableSha256: status.executableSha256, state: status.state, terminal: status.terminal,
      processTreeEnded: status.processTreeEnded, spoolComplete: status.spoolComplete, tailGapPossible: status.tailGapPossible,
      stdoutDurable: status.stdoutDurable, stdoutAcked: status.stdoutAcked, stderrDurable: status.stderrDurable,
      stderrAcked: status.stderrAcked, exitCode: status.exitCode, terminationReason: status.terminationReason ?? null, observedAt: nowIso() };
    const baselineRecord = this.store.readJson(enrollment.baselineManifest.artifactId);
    const baselineSource = this.store.readJson(baselineRecord.sourceManifest.artifactId);
    const baseline = { ...currentBaseline, baselineId: enrollment.baselineId, baselineManifest: enrollment.baselineManifest,
      sourceManifest: baselineRecord.sourceManifest, sourceDigest: enrollment.effectiveSourceDigest,
      entries: baselineSource.entries.map(({ artifact: _artifact, ...entry }) => entry),
      contentRefs: new Map(baselineSource.entries.map(entry => [entry.path, entry.artifact])) };
    const candidateAuthorization = { incidentId: link.incident_id, parentRunId: link.parent_run_id, repairRunId: state.id,
      linkId: link.id, outcomeId: authorization.outcomeId, outcomeRevision: authorization.outcomeRevision,
      developerAttemptId: attempt.id, developerNodeId: profile.developerNodeId,
      parentPublication: sourceBinding.parentPublication, repairPublication: enrollment.repairPublication,
      workspace: enrollment.workspace, enrollment: authorization.p5Enrollment, selfRepairProfile: authorization.selfRepairProfile,
      verificationPolicy: enrollment.verificationPolicy, verificationInputs: authorization.verificationInputs, sourceBinding: authorization.p5SourceBinding,
      scope: profile.scope };
    return this.captureProtectedSelfRepairCandidateDurably({ runId: state.id, link, enrollment, preparedRef,
      sourceRoot: resolve(workspace.cwd, 'source'), baseline, candidateAuthorization, terminalEvidence, readers });
  }

  /**
   * P5-GIT-2 durable candidate capture. A `self_repair.candidate_capture_started` anchor is journaled before any source
   * object is sealed; it fixes the Developer terminal evidence, capture time, journal cursor and the Host-measured source
   * digest. A replay (Engine restart, re-delivered Host terminal) reuses the journaled Git commit intent when one exists,
   * otherwise reseals under the anchor and refuses unless the live bytes reproduce the anchored identity. It never relaunches
   * the Developer, never captures a second candidate and never resets, cleans or rewrites the workspace or its Git history.
   * The caller journals `self_repair.candidate_captured` atomically with the Developer Attempt's success.
   */
  async captureProtectedSelfRepairCandidateDurably({ runId, link, enrollment, preparedRef, sourceRoot, baseline,
    candidateAuthorization, terminalEvidence, readers }) {
    const fail = (code, message) => { throw new ApiError(409, code, message); };
    custodyTransientFault('p5_before_capture_anchor');
    const journal = type => this.store.readEvents(runId).filter(item => item.type === type);
    const assertAuthorityCurrent = () => {
      const current = this.store.get('SELECT * FROM run_links WHERE id = ?', link.id);
      if (!current || current.state !== 'open' || ['stopped', 'resumed'].includes(current.parent_suspension_state)
        || journal('self_repair.candidate_invalidated').length)
        fail('p5_candidate_authority_changed', 'The P2 Repair link was stopped, settled or invalidated; no candidate capture or Git mutation follows.');
    };
    if (journal('self_repair.candidate_captured').length) fail('p5_candidate_already_captured', 'P5 permits only one sealed candidate for this P2 Repair link.');
    const gitPolicy = P5_GIT_POLICIES.includes(enrollment.gitCandidatePolicy);
    const terminalIdentity = { custodyId: terminalEvidence.custodyId, processId: terminalEvidence.processId,
      processCreationTime: terminalEvidence.processCreationTime, invocationDigest: terminalEvidence.invocationDigest,
      executableSha256: terminalEvidence.executableSha256, exitCode: terminalEvidence.exitCode };
    const captureId = canonicalHash({ kind: 'P5CandidateCapture', version: 1, linkId: link.id, repairRunId: runId,
      developerAttemptId: candidateAuthorization.developerAttemptId, allocationId: enrollment.workspace.allocationId });
    const inventoryOptions = { nativeSourceReader: readers.nativeSourceReader, include: baseline.pathPolicy.include,
      exclude: baseline.pathPolicy.exclude, maxFiles: enrollment.budgets.maxSourceFiles, maxBytes: enrollment.budgets.maxSourceBytes,
      executableFor: process.platform === 'win32' ? (modes => path => modes.get(path) ?? false)(new Map(baseline.entries.map(entry => [entry.path, entry.executable]))) : null };

    let anchors = journal('self_repair.candidate_capture_started');
    if (anchors.length > 1) fail('p5_capture_journal_conflict', 'P5 found more than one durable candidate-capture anchor.');
    let anchor;
    if (!anchors.length) {
      assertAuthorityCurrent();
      if (journal('self_repair.git_commit_intent').length)
        fail('p5_capture_journal_conflict', 'A Git commit intent exists without its candidate-capture anchor; the state is held for reconciliation.');
      const terminalRef = ref(this.store.putJson(terminalEvidence));
      this.store.verifyRef(terminalRef);
      const measured = await inventoryP5SourceWithHost(sourceRoot, inventoryOptions);
      const expectedCandidateId = p5CandidateId({ baselineId: baseline.baselineId, incidentId: candidateAuthorization.incidentId,
        parentRunId: candidateAuthorization.parentRunId, repairRunId: runId, linkId: link.id,
        developerAttemptId: candidateAuthorization.developerAttemptId, workspaceAllocationId: enrollment.workspace.allocationId,
        candidateSourceDigest: measured.sourceDigest, selfRepairProfileDigest: candidateAuthorization.selfRepairProfile.sha256,
        verificationPolicyDigest: candidateAuthorization.verificationPolicy.sha256, verificationInputsDigest: candidateAuthorization.verificationInputs.sha256 });
      const capturedAt = nowIso();
      // P5-FINAL E-02: the journal cursor is the committed sequence of the anchor event itself, assigned and verified inside the
      // one transaction that appends it, never a guess about how many events will follow.
      this.store.transaction(() => {
        if (journal('self_repair.candidate_capture_started').length)
          fail('p5_capture_journal_conflict', 'Another Engine journaled this candidate-capture anchor first.');
        assertAuthorityCurrent();
        const journalCursor = this.requireRun(runId).last_sequence + 1;
        const body = { schemaVersion: 1, kind: 'ProtectedSelfRepairCandidateCaptureAnchor', captureId, linkId: link.id,
          parentRunId: candidateAuthorization.parentRunId, repairRunId: runId, incidentId: candidateAuthorization.incidentId,
          developerAttemptId: candidateAuthorization.developerAttemptId, developerTerminalEvidence: terminalRef, terminalIdentity,
          enrollment: candidateAuthorization.enrollment, workspacePreparation: preparedRef, allocationId: enrollment.workspace.allocationId,
          workspaceIdentity: enrollment.workspace.nativeIdentity, gitCandidatePolicy: enrollment.gitCandidatePolicy ?? 'source-only',
          expectedSourceDigest: measured.sourceDigest, expectedCandidateId, sourceSnapshotDigest: measured.nativeEvidence.snapshotDigest,
          capturedAt, journalCursor };
        validateP5Contract('candidateCaptureAnchor', body);
        const anchorRef = ref(this.store.putJson(body));
        this.store.verifyRef(anchorRef);
        this.store.appendEvents(runId, [{ type: 'self_repair.candidate_capture_started', payload: { record: anchorRef }, nodeInstanceId: null, attemptId: null }]);
        if (journal('self_repair.candidate_capture_started').at(-1)?.sequence !== journalCursor)
          fail('p5_capture_journal_conflict', 'The candidate-capture anchor did not commit at its recorded journal sequence.');
      });
      custodyFaultPoint('p5_after_capture_anchor');
      anchors = journal('self_repair.candidate_capture_started');
    }
    const anchorRef = anchors[0].payload?.record;
    if (!anchorRef) fail('p5_capture_journal_corrupt', 'The candidate-capture anchor event has no record.');
    this.store.verifyRef(anchorRef);
    anchor = this.store.readJson(anchorRef.artifactId);
    validateP5Contract('candidateCaptureAnchor', anchor);
    if (canonicalHash(anchor) !== anchorRef.sha256 || anchor.captureId !== captureId || anchor.linkId !== link.id || anchor.repairRunId !== runId
      || anchor.developerAttemptId !== candidateAuthorization.developerAttemptId || anchor.allocationId !== enrollment.workspace.allocationId
      || canonicalHash(anchor.workspaceIdentity) !== canonicalHash(enrollment.workspace.nativeIdentity)
      || canonicalHash(anchor.workspacePreparation) !== canonicalHash(preparedRef)
      || canonicalHash(anchor.enrollment) !== canonicalHash(candidateAuthorization.enrollment)
      || canonicalHash(anchor.terminalIdentity) !== canonicalHash(terminalIdentity)
      || anchor.gitCandidatePolicy !== (enrollment.gitCandidatePolicy ?? 'source-only'))
      fail('p5_capture_anchor_mismatch', 'The durable candidate-capture anchor belongs to a different Developer Attempt, process, workspace or policy.');
    // Every capture derived from this anchor uses its fixed evidence, so a replay yields the same immutable records.
    const authorization = { ...candidateAuthorization, capturedAt: anchor.capturedAt, journalCursor: anchor.journalCursor,
      developerTerminal: { artifact: anchor.developerTerminalEvidence, attemptId: anchor.developerAttemptId, processTreeEnded: true,
        spoolComplete: true, status: terminalEvidence.state, exitCode: terminalEvidence.exitCode } };

    const readCandidate = candidateRef => {
      this.store.verifyRef(candidateRef);
      const value = this.store.readJson(candidateRef.artifactId);
      validateP5Contract('candidate', value);
      if (value.candidateId !== anchor.expectedCandidateId || value.candidateSourceDigest !== anchor.expectedSourceDigest
        || value.developerAttemptId !== anchor.developerAttemptId || value.capturedAt !== anchor.capturedAt
        || canonicalHash(value.developerTerminalEvidence) !== canonicalHash(anchor.developerTerminalEvidence))
        fail('p5_capture_anchor_mismatch', 'The journaled candidate differs from its durable capture anchor.');
      return value;
    };
    const intents = journal('self_repair.git_commit_intent');
    if (intents.length > 1) fail('p5_capture_journal_conflict', 'P5 found duplicate durable Git commit intents.');
    let intentRef = intents[0]?.payload?.record ?? null;
    let sealedCandidateRef = null;
    if (intentRef) {
      this.store.verifyRef(intentRef);
      sealedCandidateRef = this.store.readJson(intentRef.artifactId).candidateManifest;
      readCandidate(sealedCandidateRef);
    } else {
      assertAuthorityCurrent();
      const sealed = await sealP5Candidate({ store: this.store, sourceRoot, baseline, authorization, budgets: enrollment.budgets,
        nativeSourceReader: readers.nativeSourceReader });
      if (sealed.candidate.candidateSourceDigest !== anchor.expectedSourceDigest || sealed.candidate.candidateId !== anchor.expectedCandidateId)
        fail('p5_capture_source_drift', 'The live candidate bytes differ from the durably anchored capture; no second candidate was created and the workspace is held.');
      sealedCandidateRef = sealed.candidateArtifact;
      readCandidate(sealedCandidateRef);
      custodyFaultPoint('p5_after_candidate_seal');
      if (!gitPolicy) return { candidate: sealed.candidate, candidateArtifact: sealed.candidateArtifact, anchor: anchorRef };
      const gitToolRows = enrollment.toolIdentities.filter(item => item.name === 'git');
      if (gitToolRows.length !== 1) fail('p5_git_tool_unavailable', 'The enrolled P5 Git candidate policy requires exactly one pinned Git executable.');
      assertAuthorityCurrent();
      const commitIntent = await createP5GitCommitIntent({ store: this.store, candidateRef: sealedCandidateRef,
        preparationRef: preparedRef, gitTool: { path: gitToolRows[0].path, sha256: gitToolRows[0].sha256 },
        nativeSourceReader: readers.nativeSourceReader, nativeToolIdentityReader: readers.nativeToolIdentityReader });
      intentRef = commitIntent.intentRef;
      custodyFaultPoint('p5_after_git_commit_intent');
    }
    if (!gitPolicy) fail('p5_capture_journal_conflict', 'A Git commit intent exists for a source-only P5 enrollment.');
    assertAuthorityCurrent();
    const bound = await bindP5GitCandidate({ store: this.store, intentRef, nativeSourceReader: readers.nativeSourceReader,
      nativeToolIdentityReader: readers.nativeToolIdentityReader, capturedAt: anchor.capturedAt, faultPoint: custodyFaultPoint });
    custodyFaultPoint('p5_after_git_candidate_bound');
    custodyTransientFault('p5_after_git_candidate_bound');
    return { candidate: bound.candidate, candidateArtifact: bound.candidateArtifact, anchor: anchorRef, recovered: bound.recovered };
  }

  /** Startup view of an interrupted P5 capture; recovery itself runs when Custody re-delivers the Developer's terminal record. */
  protectedSelfRepairCaptureRecoveryState(repairRunId) {
    const events = this.store.readEvents(repairRunId);
    const count = type => events.filter(item => item.type === type).length;
    const anchors = count('self_repair.candidate_capture_started'), intents = count('self_repair.git_commit_intent');
    const captured = count('self_repair.candidate_captured');
    if (captured) return { state: 'captured', anchors, intents, captured };
    if (intents) return { state: 'git_commit_pending', anchors, intents, captured };
    if (anchors) return { state: 'seal_pending', anchors, intents, captured };
    return { state: 'none', anchors, intents, captured };
  }

  async materializeProtectedSelfRepairPreparation(intentRef, { recovery = false } = {}) {
    const enrollmentFile = this.protectedSelfRepairEnrollmentFile;
    const enrollment = this.protectedSelfRepairEnrollment;
    if (!enrollmentFile || !enrollment || !this.lifecycleClient)
      throw new ApiError(409, 'p5_enrollment_unavailable', 'P5 workspace materialization requires the current installed enrollment and Lifecycle Host.');
    const installed = await this.verifyProtectedSelfRepairEnrollmentFileCurrent();
    if (canonicalHash(installed) !== canonicalHash(enrollment))
      throw new ApiError(409, 'p5_enrollment_changed', 'The installed P5 enrollment changed before workspace materialization.');
      const currentRunningSourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
    const readers = this.protectedSelfRepairHostReaders();
    await verifyP5GitBaselineCurrent({ store: this.store, enrollment, currentRunningSourceRelease, ...readers });
    const prepareGitRepository = P5_GIT_POLICIES.includes(enrollment.gitCandidatePolicy)
      ? context => prepareP5GitRepositoryFromIntent({ ...context, ...readers, protectedRoots: [ENGINE_RELEASE_ROOT] }) : null;
    const result = await prepareP5WorkspaceFromIntent({ store: this.store, intentRef, nativeSourceReader: readers.nativeSourceReader,
      prepareGitRepository, recovery });
    const intent = this.store.readJson(intentRef.artifactId);
    const prior = this.store.readEvents(intent.repairRunId).filter(item => item.type === 'self_repair.workspace_prepared');
    if (prior.length) {
      if (prior.length !== 1 || !prior[0].payload?.record)
        throw new ApiError(409, 'p5_preparation_conflict', 'The durable P5 workspace-prepared record conflicts with the exact preparation intent.');
      const priorRef = prior[0].payload.record;
      this.store.verifyRef(priorRef);
      const priorEvidence = this.store.readJson(priorRef.artifactId);
      const stableFields = ['intent', 'workspaceRoot', 'sourceRoot', 'workspaceIdentity', 'sourceIdentity', 'baselineId', 'sourceDigest',
        'snapshotDigest', 'pathDigest', 'contentDigest', 'fileCount', 'totalBytes', 'gitRepository'];
      if (priorEvidence.kind !== 'ProtectedSelfRepairWorkspacePreparation'
        || stableFields.some(field => canonicalHash(priorEvidence[field]) !== canonicalHash(result.evidence[field])))
        throw new ApiError(409, 'p5_preparation_conflict', 'The durable P5 workspace-prepared record no longer matches its enrolled source and native workspace identity.');
      return { ...result, evidence: priorEvidence, evidenceArtifact: priorRef };
    }
    this.store.transaction(() => {
      const link = this.store.get('SELECT * FROM run_links WHERE id = ? AND parent_run_id = ? AND repair_run_id = ?', intent.linkId, intent.parentRunId, intent.repairRunId);
      const parent = this.store.get('SELECT * FROM runs WHERE id = ?', intent.parentRunId);
      const repair = this.store.get('SELECT * FROM runs WHERE id = ?', intent.repairRunId);
      const admittedAttempt = this.store.get(`SELECT 1 FROM attempts WHERE run_id = ? AND (state NOT IN ('scheduled','waiting') OR invocation_artifact_id IS NOT NULL) LIMIT 1`, intent.repairRunId);
      if (!link || link.state !== 'open' || !parent || !repair || repair.state !== 'queued' || admittedAttempt)
        throw new ApiError(409, 'p5_preparation_stale', 'P5 workspace preparation lost its queued, not-yet-dispatched P2 Repair precondition.');
      this.store.appendEvents(intent.repairRunId, [{ type: 'self_repair.workspace_prepared', payload: { record: result.evidenceArtifact }, nodeInstanceId: null, attemptId: null }]);
    });
    return result;
  }

  async reconcileProtectedSelfRepairPreparations() {
    const report = { recovered: [], alreadyPrepared: [], deferred: [], blocked: [] };
    const links = this.store.all(`SELECT l.* FROM run_links l JOIN runs r ON r.id = l.repair_run_id
      WHERE l.continuation_contract = 'logical_policy' AND l.state = 'open' ORDER BY l.created_at, l.id`);
    for (const link of links) {
      let repair, workflow;
      try {
        repair = this.requireRun(link.repair_run_id);
        workflow = this.store.readJson(repair.workflow_snapshot_artifact_id);
      } catch { continue; }
      if (!workflow?.capabilities?.includes('protected-self-repair-v1')) continue;

      // An older or unproven reader must preserve the suspended association, never dispatch it.
      // A later compatible startup can retry from the durable intent and exact Store artifacts.
      if (this.protectedSelfRepairAdmissionEnabled !== true || !this.protectedSelfRepairEnrollment
        || !this.protectedSelfRepairEnrollmentFile || !this.protectedSelfRepairEnrollmentArtifact
        || !this.lifecycleClient || !this.custodyHost || this.custodyUnavailable
        || !Number.isSafeInteger(this.custodyEpoch)) {
        report.deferred.push(link.id);
        continue;
      }

      const events = this.store.readEvents(repair.id);
      const intents = events.filter(item => item.type === 'self_repair.preparation_intent');
      const prepared = events.filter(item => item.type === 'self_repair.workspace_prepared');
      const failClosed = (code, message) => {
        const current = this.store.get('SELECT * FROM run_links WHERE id = ?', link.id);
        if (current?.state === 'open') this.blockLogicalRepair(current, code, message);
        report.blocked.push(link.id);
      };
      if (intents.length !== 1 || prepared.length > 1) {
        failClosed('p5_preparation_history_invalid', 'P5 startup recovery found a missing or duplicate durable preparation record; the linked Repair remains blocked.');
        continue;
      }
      const intentRef = intents[0].payload?.record;
      if (!intentRef) {
        failClosed('p5_preparation_intent_invalid', 'P5 startup recovery found a preparation event without its immutable intent reference.');
        continue;
      }

      try {
        this.store.verifyRef(intentRef);
        const intent = this.store.readJson(intentRef.artifactId);
        validateP5Contract('preparationIntent', intent);
        if (intent.parentRunId !== link.parent_run_id || intent.repairRunId !== link.repair_run_id
          || intent.linkId !== link.id || intent.enrollment.artifactId !== this.protectedSelfRepairEnrollmentArtifact.artifactId
          || intent.enrollment.sha256 !== this.protectedSelfRepairEnrollmentArtifact.sha256
          || intent.workspace.workspaceId !== this.protectedSelfRepairEnrollment.workspace.workspaceId)
          throw new ApiError(409, 'p5_preparation_intent_mismatch', 'The durable preparation intent does not match the current P2 link and installed enrollment.');

        if (prepared.length === 1) {
          const preparedRef = prepared[0].payload?.record;
          if (!preparedRef) throw new ApiError(409, 'p5_preparation_record_invalid', 'The workspace-prepared event has no immutable artifact reference.');
          this.store.verifyRef(preparedRef);
          const preparation = this.store.readJson(preparedRef.artifactId);
          validateP5Contract('workspacePreparation', preparation);
          if (preparation.intent.artifactId !== intentRef.artifactId || preparation.intent.sha256 !== intentRef.sha256)
            throw new ApiError(409, 'p5_preparation_record_mismatch', 'The prepared workspace is not bound to the exact durable intent.');
          report.alreadyPrepared.push(link.id);
          continue;
        }

        const parent = this.store.get('SELECT * FROM runs WHERE id = ?', link.parent_run_id);
        const currentLink = this.store.get('SELECT * FROM run_links WHERE id = ?', link.id);
        const authorization = currentLink && this.parentRepairAuthorization(currentLink);
        const admittedAttempt = this.store.get(`SELECT 1 FROM attempts WHERE run_id = ?
          AND (state NOT IN ('scheduled','waiting') OR invocation_artifact_id IS NOT NULL
            OR id IN (SELECT attempt_id FROM attempt_custody)) LIMIT 1`, repair.id);
        if (!currentLink || currentLink.state !== 'open' || !this.logicalRepairLinkIntact(currentLink)
          || !authorization?.profile?.selfRepair || !parent
          || !['running', 'waiting_for_user'].includes(parent.state)
          || !['suspension_requested', 'suspended_for_repair'].includes(currentLink.parent_suspension_state)
          || repair.state !== 'queued' || admittedAttempt)
          throw new ApiError(409, 'p5_preparation_stale', 'The P2 link, Parent suspension or queued Repair changed before P5 startup could recover preparation.');

        await this.materializeProtectedSelfRepairPreparation(intentRef, { recovery: true });
        const after = this.store.readEvents(repair.id).filter(item => item.type === 'self_repair.workspace_prepared');
        if (after.length !== 1 || !after[0].payload?.record)
          throw new ApiError(409, 'p5_preparation_recovery_incomplete', 'P5 startup materialization did not commit exactly one workspace-prepared record.');
        this.store.verifyRef(after[0].payload.record);
        const recovered = this.store.readJson(after[0].payload.record.artifactId);
        validateP5Contract('workspacePreparation', recovered);
        if (recovered.intent.artifactId !== intentRef.artifactId || recovered.intent.sha256 !== intentRef.sha256)
          throw new ApiError(409, 'p5_preparation_recovery_mismatch', 'Recovered workspace preparation does not bind to the exact durable P2 intent.');
        report.recovered.push(link.id);
      } catch (error) {
        failClosed(error.code || 'p5_preparation_recovery_failed', `P5 startup preparation recovery failed closed: ${error.message}`);
        process.stderr.write(`P5 workspace preparation recovery failed for linked Repair ${repair.id}: ${error.message}\n`);
      }
    }
    return report;
  }

  protectedSelfRepairRunProjection(repairRunId) {
    const link = this.logicalRepairLinkForRun(repairRunId);
    const authorization = link && this.parentRepairAuthorization(link);
    if (!link) return null;
    const parent = this.store.get('SELECT * FROM runs WHERE id = ?', link.parent_run_id);
    const repair = this.store.get('SELECT * FROM runs WHERE id = ?', link.repair_run_id);
    let repairWorkflow = null;
    try { if (repair) repairWorkflow = this.store.readJson(repair.workflow_snapshot_artifact_id); } catch { /* reported below */ }
    const issues = [];
    const addIssue = code => { if (!issues.includes(code)) issues.push(code); };
    const eventsFor = (runId, type) => this.store.readEvents(runId).filter(item => item.type === type);
    const exactRef = (left, right) => Boolean(left && right && left.artifactId === right.artifactId && left.sha256 === right.sha256);
    const records = (runId, type, maximum, contract = null) => {
      const events = eventsFor(runId, type);
      if (events.length > maximum) addIssue(`${type}_duplicate`);
      const values = [];
      for (const event of events) {
        const ref = event.payload?.record;
        if (!ref || event.attemptId !== null) { addIssue(`${type}_invalid_event`); continue; }
        try {
          this.store.verifyRef(ref);
          const value = this.store.readJson(ref.artifactId);
          if (contract) validateP5Contract(contract, value);
          values.push({ event, ref, value });
        } catch { addIssue(`${type}_artifact_invalid`); }
      }
      return values;
    };

    if (!parent || !repair || link.repair_run_id !== repairRunId || link.continuation_contract !== 'logical_policy')
      addIssue('link_or_run_missing');
    const p5Workflow = repairWorkflow?.capabilities?.includes('protected-self-repair-v1') === true;
    if (!authorization?.profile?.selfRepair && !p5Workflow) return null;
    if (!authorization?.profile?.selfRepair) {
      return { schemaVersion: 1, kind: 'ProtectedSelfRepairRunProjection', parentRunId: link.parent_run_id,
        repairRunId, linkId: link.id, stage: 'held_uncertain', eligible: false,
        revision: repair?.last_sequence ?? 0, issues: ['p5_authorization_missing'], candidateId: null, receiptId: null, handoffId: null };
    }

    let enrollment = null, profile = null;
    try {
      if (authorization.p5Enrollment) {
        this.store.verifyRef(authorization.p5Enrollment);
        enrollment = this.store.readJson(authorization.p5Enrollment.artifactId);
        validateP5Contract('enrollment', enrollment);
      }
      if (authorization.selfRepairProfile) {
        this.store.verifyRef(authorization.selfRepairProfile);
        profile = this.store.readJson(authorization.selfRepairProfile.artifactId);
        validateP5Contract('profile', profile);
      }
    } catch { addIssue('enrollment_or_profile_invalid'); }

    const sourceBindings = records(link.parent_run_id, 'self_repair.source_bound', 1, 'sourceBinding');
    const sourceBinding = sourceBindings[0];
    if (sourceBindings.length !== 1 || !sourceBinding || !exactRef(sourceBinding.ref, authorization.p5SourceBinding)
      || sourceBinding.value.parentRunId !== link.parent_run_id
      || sourceBinding.value.enrollmentId !== enrollment?.enrollmentId
      || sourceBinding.value.baselineId !== enrollment?.baselineId
      || !exactRef(sourceBinding.value.profile, authorization.selfRepairProfile)) addIssue('source_binding_mismatch');

    const intents = records(repairRunId, 'self_repair.preparation_intent', 1, 'preparationIntent');
    const intent = intents[0];
    if (intents.length !== 1 || !intent || intent.value.parentRunId !== link.parent_run_id
      || intent.value.repairRunId !== repairRunId || intent.value.linkId !== link.id
      || !exactRef(intent.value.enrollment, authorization.p5Enrollment)
      || !exactRef(intent.value.sourceBinding, authorization.p5SourceBinding)
      || !exactRef(intent.value.verificationInputs, authorization.verificationInputs)
      || canonicalHash(intent.value.workspace) !== canonicalHash(enrollment?.workspace ?? null)) addIssue('preparation_intent_mismatch');

    const preparations = records(repairRunId, 'self_repair.workspace_prepared', 1, 'workspacePreparation');
    const preparation = preparations[0];
    if (preparation && (!intent || !exactRef(preparation.value.intent, intent.ref)
      || preparation.value.workspaceRoot !== enrollment?.workspace.canonicalRoot
      || preparation.value.sourceRoot !== (enrollment?.workspace?.canonicalRoot ? resolve(enrollment.workspace.canonicalRoot, 'source') : null)
      || canonicalHash(preparation.value.workspaceIdentity ?? null) !== canonicalHash(enrollment?.workspace?.nativeIdentity ?? null)
      || preparation.value.baselineId !== enrollment?.baselineId
      || preparation.value.sourceDigest !== enrollment?.effectiveSourceDigest)) addIssue('workspace_preparation_mismatch');

    const anchors = records(repairRunId, 'self_repair.candidate_capture_started', 1, 'candidateCaptureAnchor');
    const anchor = anchors[0];
    if (anchor && (!preparation || anchor.value.linkId !== link.id || anchor.value.repairRunId !== repairRunId
      || anchor.value.parentRunId !== link.parent_run_id || anchor.value.incidentId !== link.incident_id
      || !exactRef(anchor.value.workspacePreparation, preparation.ref) || !exactRef(anchor.value.enrollment, authorization.p5Enrollment)
      || anchor.value.allocationId !== enrollment?.workspace?.allocationId)) addIssue('capture_anchor_mismatch');
    const commitIntents = records(repairRunId, 'self_repair.git_commit_intent', 1, 'gitCommitIntent');
    const commitIntent = commitIntents[0];
    if (commitIntent && anchor && (commitIntent.value.candidateId !== anchor.value.expectedCandidateId
      || commitIntent.value.candidateSourceDigest !== anchor.value.expectedSourceDigest || commitIntent.value.linkId !== link.id))
      addIssue('git_commit_intent_mismatch');
    const candidates = records(repairRunId, 'self_repair.candidate_captured', 1, 'candidate');
    const candidate = candidates[0];
    if (candidate && anchor && (candidate.value.candidateId !== anchor.value.expectedCandidateId
      || candidate.value.candidateSourceDigest !== anchor.value.expectedSourceDigest
      || candidate.value.developerAttemptId !== anchor.value.developerAttemptId)) addIssue('candidate_anchor_mismatch');
    if (candidate && (!preparation || candidate.value.parentRunId !== link.parent_run_id
      || candidate.value.repairRunId !== repairRunId || candidate.value.linkId !== link.id
      || candidate.value.incidentId !== link.incident_id
      || !exactRef(candidate.value.enrollment, authorization.p5Enrollment)
      || !exactRef(candidate.value.sourceBinding, authorization.p5SourceBinding)
      || !exactRef(candidate.value.verificationInputs, authorization.verificationInputs)
      || !exactRef(candidate.value.selfRepairProfile, authorization.selfRepairProfile)
      || candidate.value.baselineId !== enrollment?.baselineId)) addIssue('candidate_lineage_mismatch');

    const starts = records(repairRunId, 'self_repair.verification_started', 1, 'verificationStarted');
    const start = starts[0];
    if (start && (!candidate || start.value.runId !== repairRunId || start.value.repairRunId !== repairRunId
      || start.value.parentRunId !== link.parent_run_id || start.value.linkId !== link.id || start.value.incidentId !== link.incident_id
      || start.value.gateNodeId !== profile?.verificationNodeId || start.value.candidateId !== candidate.value.candidateId
      || start.value.candidateSourceDigest !== candidate.value.candidateSourceDigest
      || !exactRef(start.value.candidateManifest, candidate.ref) || !start.value.gateAttemptId)) addIssue('verification_start_mismatch');

    const verificationEvents = eventsFor(repairRunId, 'self_repair.verification_recorded');
    if (verificationEvents.length > 1) addIssue('verification_recorded_duplicate');
    let verification = null;
    for (const event of verificationEvents) {
      const ref = event.payload?.record;
      try {
        if (!ref || event.attemptId !== null) throw new Error('missing record');
        this.store.verifyRef(ref);
        const value = this.store.readJson(ref.artifactId);
        if (value?.kind === 'ProtectedSelfRepairVerificationReceipt') {
          validateP5Contract('verificationReceipt', value);
          if (!start || value.gateAttemptId !== start.value.gateAttemptId
            || !exactRef(value.candidateManifest, candidate?.ref) || value.issuedJournalCursor !== event.sequence
            || value.status !== 'passed') addIssue('verification_receipt_mismatch');
          else verifyP5Receipt(value, { store: this.store, candidateRef: candidate.ref,
            gateAttemptId: start.value.gateAttemptId, terminalEvidenceRef: value.terminalEvidence });
        } else if (value?.kind === 'ProtectedSelfRepairVerificationOutcome') {
          validateP5Contract('verificationOutcome', value);
          const outcomeRefs = [value.candidateManifest, value.verificationPolicy, value.verificationInputs,
            value.verifierResult, value.terminalEvidence, value.streamEvidence,
            ...value.checks.flatMap(item => [item.subjectResolution, item.overlayManifest, item.stdout, item.stderr, item.observations])];
          for (const nestedRef of outcomeRefs) if (nestedRef) this.store.verifyRef(nestedRef);
          if (!start || value.gateAttemptId !== start.value.gateAttemptId
            || value.repairRunId !== repairRunId || value.linkId !== link.id || value.incidentId !== link.incident_id
            || value.candidateId !== candidate?.value.candidateId
            || value.candidateSourceDigest !== candidate?.value.candidateSourceDigest
            || value.baselineId !== candidate?.value.baselineId
            || !exactRef(value.candidateManifest, candidate?.ref)
            || !exactRef(value.verificationPolicy, start.value.verificationPolicy)
            || !exactRef(value.verificationPolicy, candidate?.value.verificationPolicy)
            || !exactRef(value.verificationInputs, start.value.verificationInputs)
            || !exactRef(value.verificationInputs, candidate?.value.verificationInputs)
            || !['failed', 'incomplete'].includes(value.status)) addIssue('verification_outcome_mismatch');
        } else addIssue('verification_record_kind_invalid');
        verification = { event, ref, value };
      } catch { addIssue('verification_record_invalid'); }
    }

    const invalidations = records(repairRunId, 'self_repair.candidate_invalidated', 1, 'candidateInvalidation');
    const invalidation = invalidations[0];
    if (invalidation && (invalidation.value.repairRunId !== repairRunId || invalidation.value.linkId !== link.id
      || invalidation.value.parentRunId !== link.parent_run_id || invalidation.value.incidentId !== link.incident_id))
      addIssue('candidate_invalidation_mismatch');

    const carries = records(repairRunId, 'self_repair.review_delivery_carried', 64, 'reviewDeliveryCarry');
    if (carries.some(item => item.value.runId !== repairRunId
      || item.value.candidateId !== candidate?.value.candidateId
      || item.value.receiptId !== verification?.value.receiptId))
      addIssue('review_delivery_carry_mismatch');

    const retentionEvents = records(repairRunId, 'self_repair.retention_changed', 1, 'retentionRecord');
    const cleanupDeferrals = records(repairRunId, 'self_repair.cleanup_deferred', 1, 'retentionRecord');
    const handoffs = records(repairRunId, 'self_repair.handoff_recorded', 1, 'handoff');
    const retention = retentionEvents[0], cleanupDeferral = cleanupDeferrals[0], handoff = handoffs[0];
    if (retention && (!candidate || retention.value.repairRunId !== repairRunId || retention.value.linkId !== link.id
      || !exactRef(retention.value.candidateManifest, candidate.ref))) addIssue('retention_mismatch');
    if (retention && (!cleanupDeferral || !exactRef(cleanupDeferral.ref, retention.ref))) addIssue('cleanup_deferred_missing_or_mismatched');
    if (!retention && cleanupDeferral) addIssue('cleanup_deferred_without_retention');
    if (handoff && (!candidate || !retention || !exactRef(handoff.value.retentionRecord, retention.ref)
      || handoff.value.repairRunId !== repairRunId || handoff.value.linkId !== link.id
      || !exactRef(handoff.value.candidate, candidate.ref)
      || handoff.value.candidateId !== candidate.value.candidateId
      || handoff.value.candidateSourceDigest !== candidate.value.candidateSourceDigest
      || !exactRef(handoff.value.verificationReceipt, verification?.ref)
      || !exactRef(handoff.value.sourceBinding, authorization.p5SourceBinding)
      || !exactRef(handoff.value.enrollment, authorization.p5Enrollment)
      || handoff.value.currentEligibility?.eligible !== true)) addIssue('handoff_mismatch');

    const approval = link.repair_approval_artifact_id ? (() => {
      try { return this.store.readJson(link.repair_approval_artifact_id); } catch { return null; }
    })() : null;
    if (handoff) {
      try {
        const approvalRow = link.repair_approval_artifact_id && this.store.artifactRow(link.repair_approval_artifact_id);
        const outcomeRef = handoff.value.p2Outcome;
        this.store.verifyRef(outcomeRef);
        const outcome = this.store.readJson(outcomeRef.artifactId);
        validateP5Contract('p2Outcome', outcome);
        if (!approvalRow || !exactRef(handoff.value.p2Approval,
          { artifactId: link.repair_approval_artifact_id, sha256: approvalRow.sha256 })
          || outcome.parentRunId !== link.parent_run_id || outcome.repairRunId !== repairRunId
          || outcome.linkId !== link.id || outcome.incidentId !== link.incident_id
          || outcome.candidateId !== candidate?.value.candidateId
          || outcome.receiptId !== verification?.value.receiptId
          || !exactRef(outcome.p2Approval, handoff.value.p2Approval)) addIssue('p2_handoff_lineage_mismatch');
      } catch { addIssue('p2_handoff_outcome_invalid'); }
    }
    let acceptance = null;
    if (approval?.protectedSelfRepairAcceptance) {
      try {
        this.store.verifyRef(approval.protectedSelfRepairAcceptance);
        acceptance = this.store.readJson(approval.protectedSelfRepairAcceptance.artifactId);
        validateP5Contract('acceptance', acceptance);
        if (!candidate || !verification || verification.value.kind !== 'ProtectedSelfRepairVerificationReceipt'
          || !exactRef(acceptance.candidateManifest, candidate.ref)
          || !exactRef(acceptance.verificationReceipt, verification.ref)
          || acceptance.linkId !== link.id || acceptance.parentRunId !== link.parent_run_id
          || acceptance.repairRunId !== repairRunId || acceptance.incidentId !== link.incident_id)
          addIssue('acceptance_mismatch');
      } catch { addIssue('acceptance_invalid'); }
    }
    if (handoff && acceptance && (!acceptance.currentEligibility
      || canonicalHash(handoff.value.currentEligibility) !== canonicalHash(acceptance.currentEligibility)))
      addIssue('handoff_eligibility_mismatch');
    if (handoff && acceptance) {
      try {
        this.store.verifyRef(handoff.value.p2Outcome);
        const outcome = this.store.readJson(handoff.value.p2Outcome.artifactId);
        if (canonicalHash(outcome.currentEligibility) !== canonicalHash(acceptance.currentEligibility))
          addIssue('p2_outcome_eligibility_mismatch');
      } catch { addIssue('p2_outcome_eligibility_invalid'); }
    }
    if (handoff && (!acceptance || approval?.decision !== 'accept_repair')) addIssue('handoff_without_acceptance');
    if (['repair_accepted', 'resumed'].includes(link.state) && !handoff) addIssue('accepted_handoff_missing');

    const unknownEvents = [...this.store.readEvents(link.parent_run_id), ...this.store.readEvents(repairRunId)]
      .filter(item => item.type.startsWith('self_repair.') && !P5_EVENT_TYPES.includes(item.type));
    if (unknownEvents.length) addIssue('unknown_p5_event');

    // F10: a capture held on a transient Host/dependency failure, with its durable bounded-retry position.
    const captureHolds = candidate ? [] : eventsFor(repairRunId, 'self_repair.capture_held').map(event => ({ payload: this.store.readJson(event.payload.record.artifactId) }));
    let stage = 'held_uncertain';
    if (invalidation && !issues.length) stage = 'invalidated';
    else if (!issues.length && (link.state === 'parent_stopped' || link.parent_suspension_state === 'stopped')) stage = 'stopped';
    else if (!issues.length && (link.state === 'repair_failed' || link.decision_status === 'rejected')) stage = 'rejected';
    else if (!issues.length && handoff) stage = 'retained_for_p6';
    else if (!issues.length && acceptance) stage = 'accepted';
    else if (!issues.length && verification?.value.kind === 'ProtectedSelfRepairVerificationReceipt') stage = 'judge_pending';
    else if (!issues.length && verification) stage = ['failed', 'incomplete'].includes(verification.value.status) ? 'incomplete' : 'held_uncertain';
    else if (!issues.length && start) stage = 'verifying';
    else if (!issues.length && candidate) stage = 'captured';
    else if (!issues.length && (anchor || commitIntent)) stage = 'capturing';
    else if (!issues.length && preparation) {
      const developer = profile?.developerNodeId && this.latestAttempt(repairRunId, profile.developerNodeId);
      stage = developer && ['running', 'waiting'].includes(developer.state) ? 'developing' : 'prepared';
    } else if (!issues.length && intent) stage = 'preparing';
    // An accepted source repair whose Parent may not retry its failed node (failed_node_retry = never) is blocked by design:
    // the old binary must not rerun it. Its handoff stays retained for P6; every other blocked link is held.
    const retainedNeverRetry = handoff && link.state === 'blocked' && link.failed_node_retry === 'never'
      && link.decision_status === 'accepted' && link.repair_outcome === 'succeeded';
    if (!issues.length && link.state === 'blocked' && !invalidation && !retainedNeverRetry) stage = 'held_uncertain';

    if (issues.length && ['open', 'repair_completed', 'repair_accepted'].includes(link.state)) stage = 'held_uncertain';
    const terminalStages = new Set(['held_uncertain', 'incomplete', 'invalidated', 'rejected', 'stopped']);
    return { schemaVersion: 1, kind: 'ProtectedSelfRepairRunProjection', parentRunId: link.parent_run_id,
      repairRunId, linkId: link.id, stage, eligible: issues.length === 0 && !terminalStages.has(stage),
      revision: repair?.last_sequence ?? 0, issues: issues.sort(), candidateId: candidate?.value.candidateId ?? null,
      receiptId: verification?.value.receiptId ?? null, handoffId: handoff?.value.handoffId ?? null,
      ...(captureHolds.length ? { captureHold: { holdNumber: captureHolds.at(-1).payload.holdNumber, maxHolds: captureHolds.at(-1).payload.maxHolds,
        code: captureHolds.at(-1).payload.code, retryAt: captureHolds.at(-1).payload.retryAt } } : {}) };
  }

  reconcileProtectedSelfRepairProjections() {
    const report = { projected: [], blocked: [], held: [] };
    const links = this.store.all(`SELECT * FROM run_links WHERE continuation_contract = 'logical_policy'
      ORDER BY created_at, id`);
    for (const link of links) {
      const repair = this.store.get('SELECT workflow_snapshot_artifact_id FROM runs WHERE id = ?', link.repair_run_id);
      let p5Workflow = false;
      try { p5Workflow = this.store.readJson(repair.workflow_snapshot_artifact_id)?.capabilities?.includes('protected-self-repair-v1') === true; }
      catch { /* The projection reports an unreadable P5 snapshot as held when authorization marks it P5. */ }
      if (!this.parentRepairAuthorization(link)?.profile?.selfRepair && !p5Workflow) continue;
      let projection;
      try { projection = this.protectedSelfRepairRunProjection(link.repair_run_id); }
      catch (error) {
        projection = { stage: 'held_uncertain', eligible: false, issues: [error.code || 'projection_failed'] };
      }
      report.projected.push({ linkId: link.id, stage: projection?.stage ?? 'held_uncertain' });
      if (!projection || projection.issues.length) {
        if (['open', 'repair_completed', 'repair_accepted'].includes(link.state)
          && this.blockLogicalRepair(link, 'p5_projection_invalid',
            `P5 startup projection refused an inconsistent journal: ${(projection?.issues || ['projection_unavailable']).join(', ')}.`))
          report.blocked.push(link.id);
        else report.held.push(link.id);
      } else if (projection.stage === 'invalidated' && ['open', 'repair_completed'].includes(link.state)) {
        if (this.blockLogicalRepair(link, 'p5_candidate_invalidated', 'P5 candidate eligibility was revoked before startup continuation.')) report.blocked.push(link.id);
      } else if (projection.stage === 'held_uncertain') {
        report.held.push(link.id);
      }
    }
    return report;
  }

  assertWorkflowJudgeRuntimeAvailable(workflow) {
    this.workflowJudgeGuard(workflow);
  }

  migrateLegacyWorkflowPublications() {
    const state = this.store.get('SELECT legacy_import_complete FROM workflow_publication_state WHERE singleton = 1');
    if (!state || state.legacy_import_complete) return;
    this.store.transaction(() => {
      for (const row of this.store.all("SELECT * FROM workflows WHERE kind = 'user' ORDER BY id")) {
        if (this.store.get('SELECT id FROM workflow_publications WHERE workflow_id = ? LIMIT 1', row.id)) continue;
        const snapshot = this.store.artifactRow(row.snapshot_artifact_id);
        const workflow = this.store.readJson(row.snapshot_artifact_id);
        const { view, ...executionDefinition } = workflow;
        const validation = this.validateWorkflow(workflow);
        this.store.run(`INSERT INTO workflow_publications(
          id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,authority_policy_version,
          provenance,runnable,validation_json,source_draft_revision,created_at
        ) VALUES(?,?,1,?,?,?,?, 'legacy-migration',?,?,NULL,?)`, randomUUID(), row.id, row.snapshot_artifact_id,
        snapshot.sha256, canonicalHash(executionDefinition), LEGACY_AUTHORITY_POLICY, validation.valid ? 1 : 0,
        canonicalize(validation), row.created_at);
      }
      this.store.run('UPDATE workflow_publication_state SET legacy_import_complete = 1 WHERE singleton = 1');
    });
  }

  // ---------- Restart recovery ----------
  // Processes this Engine recorded for its attempts that are still alive at a restart. The record is the attempt's own (its process id and
  // creation time), read again on every start, so a survivor stays visible to the next restart even after its attempt is interrupted.
  // A process is terminated only under standalone containment and only when its creation time is the one recorded. One that survives
  // keeps its workspace unavailable to Custody and to managed-task deliveries until it ends (checked on each use). Under standalone
  // containment a survivor that cannot be terminated also blocks new runs until the runtime restarts. Under the supervisor, a process
  // belongs to the supervisor's Job, which is not asked here.
  async recoverSurvivors(uncertain, unconfirmed) {
    const standalone = this.processContainment === 'standalone-best-effort';
    for (const attempt of this.store.all(`SELECT a.id, a.run_id, a.state, a.process_id, a.process_start_identity FROM attempts a
      WHERE a.process_id IS NOT NULL AND a.state IN ('running', 'interrupted')
        AND NOT EXISTS (SELECT 1 FROM attempt_custody c WHERE c.attempt_id = a.id)`)) {
      if (!isAlive(attempt.process_id)) continue;
      const started = await processStartTime(attempt.process_id);
      const launched = Date.parse(attempt.process_start_identity?.split('@')[1] || '');
      const identified = started !== null && Number.isFinite(launched);
      // A creation time other than the recorded one is another process: a reused PID is not this attempt's process.
      if (identified && Math.abs(started - launched) > STARTUP_TOLERANCE_MS) continue;
      // A process whose identity cannot be read is not known to be ours; it is held only when its attempt was running at this restart.
      if (!identified && attempt.state !== 'running') continue;
      if (standalone && identified) await killTree(attempt.process_id);
      if (!isAlive(attempt.process_id)) continue;
      if (standalone && identified) uncertain.push(attempt.process_id);
      unconfirmed.push({ pid: attempt.process_id, cwd: this.store.get('SELECT w.cwd FROM workspaces w JOIN runs r ON r.workspace_id = w.id WHERE r.id = ?', attempt.run_id)?.cwd ?? null });
    }
  }

  async recover() {
    const open = this.store.all(`SELECT * FROM runs WHERE state IN ${ACTIVE_SQL} ORDER BY created_at`);
    const uncertain = [], unconfirmedWorkspaces = [];
    await this.recoverSurvivors(uncertain, unconfirmedWorkspaces);
    // Read by the continuation check: a Run whose workspace an unconfirmed process may still use is not continued.
    this.unconfirmedWorkspaces = unconfirmedWorkspaces;
    // A process that a restart could not confirm ended blocks every continuation, as it blocks new Runs (createRun).
    const blocked = uncertain.length > 0;
    for (const run of open) {
      // P1: a Run continues only on the exact published definition it was captured from. One that does not verify is interrupted below.
      const intact = this.publishedDefinitionIntact(run);
      let unsupportedJudge = false;
      if (intact) unsupportedJudge = !this.workflowJudgeRuntimeAvailable(this.store.readJson(run.workflow_snapshot_artifact_id));
      // Preserve ordinary linked/lifecycle holds. P4 Runs continue only with the supported Process Custody profile.
      if (intact && this.isContinuationHeld(run) && !unsupportedJudge) continue;
      // A queued Run has dispatched nothing: startRun starts it, as it would have without the restart, when the restart gates pass.
      if (run.state === 'queued' && intact && !unsupportedJudge && this.restartGatesPass(run, blocked)) continue;
      // A Host-owned CLI is reattached only when the Run passes the same restart gates as ordinary continuation. Otherwise its
      // custody process is stopped through the Host, and the Run keeps its existing restart outcome.
      const custodyRows = this.store.all(`SELECT a.id AS attempt_id, a.state, c.custody_id FROM attempts a JOIN attempt_custody c ON c.attempt_id = a.id
        WHERE a.run_id = ? AND (a.state = 'running' OR (a.state IN ('scheduled','waiting') AND a.invocation_artifact_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM run_links l WHERE l.continuation_contract = 'logical_policy' AND (l.parent_run_id = a.run_id OR l.repair_run_id = a.run_id))
          AND NOT EXISTS (SELECT 1 FROM journal_events j WHERE j.run_id = a.run_id AND j.attempt_id = a.id AND j.event_type = 'attempt.launch_withdrawn')))`, run.id);
      const custodyIds = new Set(custodyRows.map(row => row.attempt_id));
      const resumable = intact && this.restartGatesPass(run, blocked) && custodyRows.length > 0
        && custodyRows.every(row => row.state === 'running')
        && this.store.all(`SELECT id FROM attempts WHERE run_id = ? AND state = 'running'`, run.id).every(row => custodyIds.has(row.id));
      if (resumable) for (const row of custodyRows) this.custodyResumes.push({ run_id: run.id, attempt_id: row.attempt_id });
      else for (const row of custodyRows) this.custodyAbandon.push(row.custody_id);
      // A committed Root Stop is itself durable intent. If no attempt or Host admission remains in flight, finish that intent
      // through the ordinary canceled settlement instead of rewriting it as an unrelated runtime interruption.
      const pendingStopWork = this.store.get(`SELECT 1 FROM attempts WHERE run_id = ? AND state IN ('running','draining','scheduled','waiting') LIMIT 1`, run.id);
      if (run.state === 'stopping' && custodyRows.length === 0 && !pendingStopWork) {
        const state = this.loadRunState(run);
        this.runs.set(run.id, state);
        this.finishRunIfDone(state);
        continue;
      }
      // P1: an ordinary Run with no attempt in flight, and no launch of unknown outcome, continues from its durable state.
      if (!resumable && this.canContinueRun(run, intact, blocked) && this.rebuildRunState(run)) continue;
      this.store.transaction(() => {
        const events = [];
        for (const attempt of this.store.all('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', run.id)) {
          const loop = this.store.get('SELECT 1 FROM loop_executions WHERE run_id = ? AND attempt_id = ?', run.id, attempt.id) || this.store.get('SELECT 1 FROM map_executions WHERE run_id = ? AND attempt_id = ?', run.id, attempt.id) || this.store.get('SELECT 1 FROM managed_tasks WHERE run_id=? AND attempt_id=?', run.id, attempt.id);
          if (resumable && custodyIds.has(attempt.id)) continue;
          if (attempt.state === 'running' || (loop && attempt.state === 'waiting')) events.push(...this.attemptTransition(attempt, 'interrupted', 'Runtime restarted while the attempt was active.'));
          // A resumed run is not interrupted, so its planned-but-unstarted attempts remain schedulable.
          else if (UNSTARTED.has(attempt.state) && !resumable) events.push(...this.attemptTransition(attempt, 'canceled', 'Runtime restarted before the attempt started.'));
        }
        this.store.run(`UPDATE loop_executions SET state = 'interrupted', pause_reason = NULL WHERE run_id = ? AND state IN ('running','paused')`, run.id);
        this.store.run(`UPDATE map_executions SET state = 'interrupted', pause_reason = NULL WHERE run_id = ? AND state IN ('running','paused','finishing')`, run.id);
        this.interruptManagedTasks(run.id, events);
        this.store.run(`UPDATE loop_iterations SET outcome = 'interrupted', ended_at = ? WHERE run_id = ? AND outcome IN ('running','paused')`, nowIso(), run.id);
        for (const binding of this.store.all(`SELECT b.* FROM context_bindings b JOIN run_context_bindings m ON m.binding_id = b.id WHERE m.run_id = ? AND b.state = 'writing'`, run.id))
          events.push(this.bindingTransition(binding, 'needs_review', 'Runtime restarted during a native write; native history may have advanced.')[0]);
        if (!resumable) {
          const reason = !intact ? 'Recovery refused: the published workflow definition of this Run is missing or inconsistent.'
            : unsupportedJudge ? 'Unsupported runtime: workflow-judge/1 execution is unavailable; the Run was interrupted without resumption.'
              : 'Runtime restarted or lost process supervision.';
          this.workflowJudgeSupersedeAttentionInTransaction(run.id, reason, events);
          this.workflowJudgeSupersedeQuestionsInTransaction(run.id, reason, events);
          events.push(this.runEvent(run, 'interrupted', reason));
          if (!intact) {
            const outcome = this.failureOutcomeEvent(null, { runId: run.id,
              outcomeId: deterministicOutcomeId(run.id, 'published_definition_integrity'), source: 'recovery', code: 'corruption',
              causeKnowledge: 'direct_fact', executionCertainty: 'unknown', sideEffectCertainty: 'unknown', runState: 'interrupted' });
            if (outcome) events.push(outcome);
          }
        }
        this.store.appendEvents(run.id, events);
      });
    }
    // Reconcile terminal runs whose grant cleanup was interrupted by a crash.
    for (const grant of this.store.all(`SELECT g.run_id FROM control_grants g JOIN runs r ON r.id = g.run_id
      WHERE g.state = 'active' AND r.state IN ('succeeded','failed','canceled','interrupted')`)) this.endControl(grant.run_id);
    this.store.run('DELETE FROM resource_locks');
    this.recoveryBlocked = uncertain.length ? `Owned processes could not be confirmed terminated: ${uncertain.join(', ')}. Close them, then restart the runtime.` : null;
    this.unconfirmedWorkspaces = unconfirmedWorkspaces;
    this.watchUnconfirmed();
  }

  // P1: a Run continues only on the exact published definition it was captured from. Its snapshot must still verify, hash to the execution
  // hash recorded at capture, and be the snapshot of the publication it names with the same digest.
  publishedDefinitionIntact(run) {
    let workflow;
    // A snapshot that is missing or fails its digest is inconsistent. Any other read failure is not a verdict on the Run, so it stops startup.
    try { workflow = this.store.readJson(run.workflow_snapshot_artifact_id); }
    catch (error) { if (error instanceof CorruptionError) return false; throw error; }
    const { view, ...definition } = workflow;
    if (canonicalHash(definition) !== run.execution_hash) return false;
    if (run.published_version_id === null) return true;
    const publication = this.store.get('SELECT snapshot_artifact_id, definition_digest, execution_hash FROM workflow_publications WHERE id = ?', run.published_version_id);
    return publication?.snapshot_artifact_id === run.workflow_snapshot_artifact_id && publication.definition_digest === run.definition_digest
      && publication.execution_hash === run.execution_hash;
  }

  // ADR-0008 lifecycle links retain P1's conservative restart exclusion. P2 logical-policy links
  // enter recovery only through the explicit association and published-workflow checks below.
  isLinkedRun(runId) { return Boolean(this.store.get("SELECT 1 FROM run_links WHERE continuation_contract <> 'logical_policy' AND (parent_run_id = ? OR repair_run_id = ?)", runId, runId)); }

  // The conditions every restart continuation shares. Anything that depends on state a restart loses (a supervised Run's observer, a
  // host-bound admission, a linked Repair) or on a process that may still run keeps the restart rule it always had.
  restartGatesPass(run, blocked) {
    if (blocked || this.hostAuthority || this.hostVerificationOnly || run.kind !== 'workflow' || run.journal_version < 2) return false;
    if (this.isLinkedRun(run.id) || this.store.get(`SELECT 1 FROM control_grants WHERE run_id = ? AND state = 'active'`, run.id)) return false;
    const logicalRepair = this.logicalRepairLinkForRun(run.id);
    if (logicalRepair && !this.logicalRepairLinkIntact(logicalRepair, run)) return false;
    // Queued Runs take this shortcut before canContinueRun. P4 is recoverable only when its Process Custody profile is active.
    const workflow = this.store.readJson(run.workflow_snapshot_artifact_id);
    if (workflow.capabilities?.includes('protected-self-repair-v1') && this.protectedSelfRepairAdmissionEnabled !== true) return false;
    if ((workflow.judgePolicy && !this.workflowJudgeRuntimeAvailable(workflow)) || allNodesDeep(workflow.nodes).some(node => ['loop', 'map', 'task'].includes(node.type))) return false;
    const workspace = this.store.get('SELECT w.cwd FROM workspaces w JOIN runs r ON r.workspace_id = w.id WHERE r.id = ?', run.id);
    return !this.unconfirmedOverlapping(workspace?.cwd ?? null);
  }

  // P1: the scheduler state of a continued Run is rebuilt from its captured definition and durable attempts, and the continuation is journaled.
  // A Run whose state cannot be rebuilt is not continued: it keeps the restart rule, and startup is not blocked by it.
  rebuildRunState(run) {
    try {
      this.ensureRunState(run.id);
      this.store.transaction(() => this.store.appendEvents(run.id, [{ type: 'continuation.reconciled', payload: { origin: 'ENGINE', pass: 'startup', scheduler: 'rebuilt' }, nodeInstanceId: null, attemptId: null }]));
      return true;
    } catch (error) {
      this.runs.delete(run.id);
      process.stderr.write(`Run ${run.id} is not continued after restart: ${error.message}\n`);
      return false;
    }
  }

  // P1: an ordinary workflow Run continues after a restart only while nothing of it can still be executing and no launch of it has an
  // unknown outcome. Anything else keeps the restart rules it always had: running work is interrupted, never relaunched.
  canContinueRun(run, intact, blocked) {
    if (!intact || !['running', 'draining', 'waiting_for_user'].includes(run.state) || !this.restartGatesPass(run, blocked)) return false;
    // An attempt that may still execute, or whose launch may have happened without a recorded outcome. An attempt the restart or a
    // runtime shutdown interrupted has an unknown outcome as well: its Run is interrupted, not offered for a decision.
    if (this.store.get(`SELECT 1 FROM attempts a WHERE a.run_id = ? AND (a.state IN ('running', 'interrupted')
      OR (a.state IN ('scheduled', 'waiting') AND (a.invocation_artifact_id IS NOT NULL OR a.id IN (SELECT attempt_id FROM attempt_custody))
        AND NOT EXISTS (SELECT 1 FROM journal_events j WHERE j.run_id = a.run_id AND j.attempt_id = a.id AND j.event_type = 'attempt.launch_withdrawn')))`, run.id)) return false;
    if (this.store.get(`SELECT 1 FROM context_bindings b JOIN run_context_bindings m ON m.binding_id = b.id WHERE m.run_id = ? AND b.state = 'writing'`, run.id)) return false;
    // Loops, Maps and Managed Tasks keep their existing restart rules; their recovery is not part of P1.
    const workflow = this.store.readJson(run.workflow_snapshot_artifact_id);
    return !allNodesDeep(workflow.nodes).some(node => ['loop', 'map', 'task'].includes(node.type));
  }

  // ---------- Capabilities and settings ----------
  async detect(provider, { fresh = false, processCustody = false } = {}) {
    if(this.hostVerificationOnly)return{provider,available:false,cliVersion:null,supportsNew:false,supportsResume:false,supportsJson:false,supportsInheritedConfiguration:false,reason:'Provider operations are unavailable during native verification.'};
    const cacheKey = `${provider}:${processCustody ? 'custody' : 'standard'}`;
    const cached = this.detections.get(cacheKey);
    if (!fresh && cached && Date.now() - cached.at < this.detectionTtlMs) return cached.value;
    const value = await this.adapters.detect(provider, { processCustody });
    this.detections.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  async capabilities() {
    const providers = await Promise.all(PROVIDERS.map(provider => this.detect(provider, { fresh: true })));
    const body = {
      schemaVersion: 1, engineCapabilities: ['core-v1', 'loops-v1', 'cache-v1', 'pipeline-v1', 'delivery-v1', 'revisions-v1', 'task-planning-v1'],
      providers: providers.map(p => ({ provider: p.provider, available: p.available, cliVersion: p.cliVersion, supportsNew: p.supportsNew, supportsResume: p.supportsResume, supportsJson: p.supportsJson, supportsInheritedConfiguration: p.supportsInheritedConfiguration, reason: p.reason })),
      maximumAgentTimeoutSeconds: this.maximumAgentTimeoutSeconds, processContainment: this.processContainment,
    };
    assertValid(API, 'capabilities', body);
    if (capabilityIssues(body).length) throw new Error('Capabilities must contain each provider exactly once.');
    return body;
  }

  currentSettings() {
    const row = this.store.get('SELECT * FROM application_settings WHERE singleton = 1');
    const settings = this.store.readJson(row.settings_artifact_id);
    if (settings.externalRunConfirmation === undefined) settings.externalRunConfirmation = true;
    if (this.externalRunConfirmationOverride !== null) settings.externalRunConfirmation = this.externalRunConfirmationOverride;
    const digest = this.externalRunConfirmationOverride === null
      ? this.store.artifactRow(row.settings_artifact_id).sha256
      : canonicalHash(settings);
    return { revision: row.revision, sha256: digest, settings, artifactId: row.settings_artifact_id };
  }
  settingsBody() { const { revision, sha256: digest, settings } = this.currentSettings(); return { revision, sha256: digest, settings }; }

  updateSettings(body) {
    this.validateBody('updateApplicationSettings', body);
    return this.idempotent('PUT /settings', body.requestId, body, () => {
      const current = this.currentSettings();
      if (body.expectedRevision !== current.revision) throw new ApiError(409, 'conflict', `Settings revision is ${current.revision}, not ${body.expectedRevision}.`);
      return this.store.transaction(() => {
        const artifact = this.store.putJson(body.settings);
        const revision = current.revision + 1;
        this.store.run('UPDATE application_settings SET revision = ?, settings_artifact_id = ?, updated_at = ? WHERE singleton = 1', revision, artifact.artifactId, nowIso());
        for (const run of this.store.all(`SELECT id FROM runs WHERE state IN ${ACTIVE_SQL}`))
          this.store.appendEvents(run.id, [{ type: 'run.capacity_changed', payload: { revision, settings: ref(artifact) } }]);
        return { status: 200, body: this.settingsBody() };
      });
    }, () => queueMicrotask(() => this.pump()));
  }

  // ---------- Generic helpers ----------
  validateBody(definition, body) {
    const issues = check(API, definition, body);
    if (issues.length) throw new ApiError(400, 'invalid_request', `Request does not match ${definition}.`, issues);
  }

  idempotent(command, requestId, payload, fn, after) {
    const digest = canonicalHash({ command, payload });
    const result = this.store.transaction(() => {
      const receipt = this.store.get('SELECT * FROM command_receipts WHERE request_id = ?', requestId);
      if (receipt) {
        if (receipt.payload_sha256 !== digest || receipt.command !== command) throw new ApiError(409, 'conflict', 'This requestId was already used for a different command or payload.');
        return { response: this.store.readJson(receipt.response_artifact_id), isNew: false };
      }
      const response = fn();
      const artifact = this.store.putJson(response);
      this.store.run('INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at) VALUES (?, ?, ?, ?, ?)', requestId, command, digest, artifact.artifactId, nowIso());
      return { response, isNew: true };
    });
    if (result.isNew) after?.();
    return result.response;
  }

  replayCommittedReceipt(command, requestId, payload, { ignoreDifferentCommand = false } = {}) {
    const receipt = this.store.get('SELECT * FROM command_receipts WHERE request_id = ?', requestId);
    if (!receipt) return { found: false };
    if (receipt.command !== command) {
      if (ignoreDifferentCommand) return { found: false };
      throw new ApiError(409, 'conflict', 'This requestId was already used for a different command or payload.');
    }
    const digest = canonicalHash({ command, payload });
    if (receipt.payload_sha256 !== digest) throw new ApiError(409, 'conflict', 'This requestId was already used for a different command or payload.');
    return { found: true, response: this.store.readJson(receipt.response_artifact_id) };
  }

  closePendingRunRequestsAtOwnerCutover() {
    const problem = canonicalize({
      code: 'policy_cutover',
      message: 'This pending Run request was denied when the Runtime Owner authorization policy changed. Submit a new Run request.',
      details: [],
    });
    return this.store.transaction(() => this.store.run(
      "UPDATE external_run_requests SET state = 'denied', problem_json = ? WHERE state = 'pending'",
      problem,
    ).changes);
  }

  encodeCursor(data) {
    const body = Buffer.from(canonicalize(data)).toString('base64url');
    return `${body}.${createHmac('sha256', this.cursorSecret).update(body).digest('base64url')}`;
  }
  decodeCursor(cursor, collection, filters) {
    const [body, mac] = String(cursor).split('.');
    if (!body || !mac || createHmac('sha256', this.cursorSecret).update(body).digest('base64url') !== mac) throw new ApiError(400, 'invalid_request', 'The cursor is malformed or was issued by another runtime.');
    const data = parseStrictJson(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.collection !== collection || canonicalize(data.filters) !== canonicalize(filters)) throw new ApiError(400, 'invalid_request', 'The cursor does not match this collection or filter.');
    return data;
  }

  // Seek pagination: newest first, fenced at the first page so later inserts never shift pages.
  page({ collection, table, filters, where = [], params = [], limit = LIST_DEFAULT, cursor, map }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 200.');
    const clauses = [...where], bound = [...params];
    let fence = null;
    if (cursor) {
      const data = this.decodeCursor(cursor, collection, filters);
      fence = data.fence;
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); bound.push(data.last[0], data.last[0], data.last[1]);
      clauses.push('(created_at < ? OR (created_at = ? AND id <= ?))'); bound.push(fence[0], fence[0], fence[1]);
    }
    const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.store.db.prepare(sql).all(...bound, limit + 1);
    const items = rows.slice(0, limit);
    if (!fence && items.length) fence = [items[0].created_at, items[0].id];
    const last = items.at(-1);
    return { items: items.map(map), nextCursor: rows.length > limit ? this.encodeCursor({ collection, filters, fence, last: [last.created_at, last.id] }) : null };
  }

  // ---------- Workspaces ----------
  workspaceBody(row) { return { workspaceId: row.id, cwd: row.cwd, cwdIdentity: row.cwd_identity, createdAt: row.created_at, updatedAt: row.updated_at }; }

  putWorkspace(workspaceId, body) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(workspaceId)) throw new ApiError(400, 'invalid_request', 'Workspace ID must match the workflow ID grammar.');
    this.validateBody('workspaceRequest', body);
    const scratch = canonicalPath(join(this.store.workdirs, 'scratch'));
    const requested = resolve(body.cwd);
    if (!existsSync(requested) && within(process.platform === 'win32' ? requested.toLowerCase() : requested, scratch)) mkdirSync(requested, { recursive: true });
    if (!existsSync(requested) || !statSync(requested).isDirectory()) throw new ApiError(422, 'validation_failed', 'The workspace directory must exist.');
    const canonical = canonicalPath(requested);
    this.assertNoAuthoringDirectoryConflict(canonical);
    const store = canonicalPath(this.store.storeDir);
    if (within(canonical, store) || within(store, canonical)) throw new ApiError(422, 'validation_failed', 'The workspace directory may not contain or be inside the trusted store.');
    const identity = sha256(Buffer.from(canonical, 'utf8'));
    const existing = this.store.get('SELECT * FROM workspaces WHERE id = ?', workspaceId);
    const now = nowIso();
    if (existing) {
      if (existing.cwd_identity !== identity && this.activeRun(workspaceId)) throw new ApiError(409, 'conflict', 'A run is active in this workspace; it cannot be rebound now.');
      this.store.run('UPDATE workspaces SET cwd = ?, cwd_identity = ?, updated_at = ? WHERE id = ?', requested, identity, now, workspaceId);
    } else {
      this.store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', workspaceId, requested, identity, now, now);
    }
    return this.workspaceBody(this.store.get('SELECT * FROM workspaces WHERE id = ?', workspaceId));
  }

  assertNoAuthoringDirectoryConflict(workspaceRoot) {
    const activeSince = new Date(Date.now() - 90_000).toISOString();
    for (const bridge of this.store.all("SELECT working_directory, mcp_config_path FROM bridge_registrations WHERE client_provider = 'antigravity' AND last_seen_at >= ?", activeSince)) {
      for (const candidate of [bridge.working_directory, bridge.mcp_config_path].filter(Boolean)) {
        const path = canonicalPath(candidate);
        if (within(path, workspaceRoot) || within(workspaceRoot, path))
          throw new ApiError(422, 'authoring_directory_conflict', 'The workspace root overlaps a connected Antigravity authoring directory or MCP config path.');
      }
    }
  }

  listWorkspaces({ limit, cursor } = {}) {
    return this.page({ collection: 'workspaces', table: 'workspaces', filters: {}, limit, cursor, map: row => this.workspaceBody(row) });
  }

  requireWorkspace(id) {
    const row = this.store.get('SELECT * FROM workspaces WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'not_found', `Workspace "${id}" does not exist.`);
    return row;
  }
  activeRun(workspaceId) { return this.store.get(`SELECT id, state FROM runs WHERE workspace_id = ? AND state IN ${ACTIVE_SQL}`, workspaceId); }

  // ---------- Workflows ----------
  validateWorkflow(workflow) {
    const structural = structuralIssues(workflow);
    if (structural.length) return { valid: false, issues: structural };
    const issues = semanticIssues(workflow, { maximumAgentTimeoutSeconds: this.maximumAgentTimeoutSeconds }).map(({ path, message }) => ({ path, message }));
    issues.push(...this.workflowJudgePublicationIssues(workflow));
    return { valid: issues.length === 0, issues };
  }

  workflowJudgePublicationIssues(workflow) {
    const policy = workflow.judgePolicy;
    if (!policy) return [];
    const issues = [];
    policy.repairProfiles.forEach((profile, index) => {
      const at = `/judgePolicy/repairProfiles/${index}`;
      if (!this.store.get('SELECT id FROM workspaces WHERE id = ?', profile.repairWorkspaceId))
        issues.push({ path: `${at}/repairWorkspaceId`, message: `Repair workspace "${profile.repairWorkspaceId}" is not registered.` });
      if (profile.repairWorkflowId === workflow.workflowId) return;

      const publication = this.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id
        WHERE p.workflow_id = ? AND p.version = ?`, profile.repairWorkflowId, profile.repairPublishedVersion);
      if (!publication || !publication.runnable || publication.snapshot_sha256 !== profile.repairWorkflowSnapshotSha256) {
        issues.push({ path: `${at}/repairPublishedVersion`, message: 'Repair profile must pin an existing runnable Published Version with the exact workflow snapshot digest.' });
        return;
      }

      const repairWorkflow = this.store.readJson(publication.snapshot_artifact_id);
      const repairNodes = allNodesDeep(repairWorkflow.nodes);
      const unsupported = repairNodes.find(node => ['loop', 'map', 'task'].includes(node.type));
      if (unsupported) issues.push({ path: `${at}/repairPublishedVersion`, message: `P4 Repair publication contains unsupported ${unsupported.type} execution.` });
      const resultNode = repairWorkflow.nodes.find(node => node.id === profile.repairResultNodeInstanceId);
      if (!resultNode || !['agent', 'text'].includes(resultNode.type))
        issues.push({ path: `${at}/repairResultNodeInstanceId`, message: 'Repair result node must reference a top-level Agent or Text node in the pinned publication.' });
      for (const [verificationIndex, nodeId] of profile.verificationNodeInstanceIds.entries()) {
        const node = repairWorkflow.nodes.find(item => item.id === nodeId);
        if (!node || !['agent', 'gate'].includes(node.type))
          issues.push({ path: `${at}/verificationNodeInstanceIds/${verificationIndex}`, message: 'Each verification node must reference a top-level Agent or Gate node in the pinned publication.' });
      }

      const childPolicy = repairWorkflow.judgePolicy;
      if (profile.acceptanceMode === 'judge_post_execution'
        && (publication.authority_policy_version !== WORKFLOW_JUDGE_POLICY_VERSION || childPolicy?.version !== WORKFLOW_JUDGE_POLICY_VERSION))
        issues.push({ path: `${at}/acceptanceMode`, message: 'judge_post_execution requires a Repair publication explicitly bound to workflow-judge/1.' });
      if (childPolicy?.repairProfiles?.length)
        issues.push({ path: `${at}/repairPublishedVersion`, message: 'A P4 Repair publication cannot declare further model-originated Repair profiles.' });
    });
    return issues;
  }

  savedWorkflow(row) {
    const workflow = this.store.readJson(row.snapshot_artifact_id);
    const { view, ...definition } = workflow;
    return { workflow, snapshotSha256: this.store.artifactRow(row.snapshot_artifact_id).sha256, executionHash: canonicalHash(definition), validation: this.validateWorkflow(workflow) };
  }

  runtimeIdentity() {
    const identity = this.store.get('SELECT store_id FROM runtime_identity WHERE singleton = 1');
    return { storeId: identity.store_id, runtimeInstanceId: this.runtimeInstanceId, applicationRoot: canonicalPath(this.root), nodeExecutable: this.nodeExecutable };
  }

  authoringContract() {
    const identity = this.runtimeIdentity();
    const workflowSchema = SCHEMAS['workflow.schema.json'];
    return {
      descriptorVersion: 1, contractVersion: '4.0', apiVersions: ['v2', 'v3', 'v4'], ...identity,
      workflowSchemaId: 'workflow.schema.json', workflowSchemaSha256: sha256(canonicalBytes(workflowSchema)),
      capabilities: ['core-v1', 'loops-v1', 'cache-v1', 'pipeline-v1', 'delivery-v1', 'revisions-v1', 'task-planning-v1'],
      limits: { maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 4 * 1024 * 1024, maxPageSize: 200, maxEventPageSize: 200 },
    };
  }

  authoringSchema(schemaId) {
    const schema = SCHEMAS[schemaId];
    if (!schema || !/^[a-z0-9-]+\.schema\.json$/.test(schemaId)) throw new ApiError(404, 'not_found', `Schema "${schemaId}" is not published by this runtime.`);
    const references = new Set();
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) references.add(value.$ref.split('#')[0].split('/').at(-1));
      for (const child of Object.values(value)) visit(child);
    };
    visit(schema);
    return { schemaId, version: 1, sha256: sha256(canonicalBytes(schema)), schema, dependencies: [...references].sort() };
  }

  authoringNodeTypes() {
    const definitions = {
      text: 'textNode', 'prompt-template': 'promptTemplateNode', agent: 'agentNode', context: 'contextNode',
      'result-viewer': 'resultViewerNode', 'file-input': 'fileInputNode', merge: 'mergeNode', 'json-select': 'jsonSelectNode',
      condition: 'conditionNode', loop: 'loopNode', cache: 'cacheNode', route: 'routeNode', gate: 'gateNode', map: 'mapNode', task: 'taskNode',
    };
    return { schemaId: 'workflow.schema.json', types: Object.entries(definitions).map(([type, definition]) => ({
      type, schemaRef: `workflow.schema.json#/$defs/${definition}`, configurationDependentPorts: true,
      portRules: 'Ports are derived from the node configuration by the same validator used for workflow saves and validation.',
    })) };
  }

  authoringTemplates() {
    return [
      { templateId: 'empty', version: 1, title: 'Empty workflow', requiredCapabilities: ['core-v1'], placeholders: ['workflowId'] },
      { templateId: 'context-chain', version: 1, title: 'Context chain', requiredCapabilities: ['core-v1'], placeholders: ['workflowId', 'codexModel', 'claudeModel'] },
      { templateId: 'delivery-loop', version: 1, title: 'Delivery Loop reference', requiredCapabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'delivery-v1'], placeholders: ['workflowId', 'modelIds'] },
      { templateId: 'managed-task', version: 1, title: 'Managed development task', requiredCapabilities: ['core-v1', 'loops-v1', 'task-planning-v1'], placeholders: ['workflowId', 'request', 'sourcePaths', 'roleBindings', 'checks'] },
    ];
  }

  authoringTemplate(templateId) {
    const metadata = this.authoringTemplates().find(item => item.templateId === templateId);
    if (!metadata) throw new ApiError(404, 'not_found', `Template "${templateId}" is not published by this runtime.`);
    let workflow;
    if (templateId === 'empty') {
      workflow = { schemaVersion: 1, workflowId: 'replace-with-workflow-id', capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
        nodes: [
          { id: 'request', type: 'text', config: { value: 'Replace this with the requested workflow input.' } },
          { id: 'result', type: 'result-viewer', config: {} },
        ], edges: [{ id: 'request-text-result', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'result', port: 'value' } }], after: [] };
    } else {
      workflow = structuredClone(templateId === 'context-chain' ? contextChainExample : templateId === 'managed-task' ? managedTaskExample : deliveryExample);
      workflow.workflowId = 'replace-with-workflow-id';
      for (const node of allNodesDeep(workflow.nodes)) {
        if (node.type === 'agent') { node.config.model = `replace-with-${node.config.provider}-model-id`; node.config.effort ??= DEFAULT_EFFORT; }
        if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') { role.model = `replace-with-${role.provider}-model-id`; role.effort ??= DEFAULT_EFFORT; }
      }
    }
    return { ...metadata, workflow, notes: 'This is an example. Replace every explicit placeholder with a user-selected value, then discover, validate, and save it through this runtime.' };
  }

  registerBridge(body) {
    if (!body || typeof body.bridgeId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(body.bridgeId) || !['codex', 'claude', 'antigravity', 'other'].includes(body.clientProvider))
      throw new ApiError(400, 'invalid_request', 'A bridge handshake requires a UUID bridgeId and a supported clientProvider.');
    let workingDirectory = null, mcpConfigPath = null;
    if (body.clientProvider === 'antigravity') {
      if (typeof body.workingDirectory !== 'string' || typeof body.mcpConfigPath !== 'string')
        throw new ApiError(422, 'authoring_directory_conflict', 'Antigravity bridge registration requires its working directory and resolved MCP config path.');
      try {
        workingDirectory = canonicalPath(body.workingDirectory);
        mcpConfigPath = canonicalPath(body.mcpConfigPath);
        if (!statSync(workingDirectory).isDirectory() || !statSync(mcpConfigPath).isFile()) throw new Error('Path type mismatch');
      } catch {
        throw new ApiError(422, 'authoring_directory_conflict', 'Antigravity bridge paths must be absolute, resolvable, and identify an existing directory and config file.');
      }
      const roots = this.store.all('SELECT cwd FROM workspaces');
      for (const workspace of roots) {
        const root = canonicalPath(workspace.cwd);
        if ([workingDirectory, mcpConfigPath].some(path => within(path, root) || within(root, path)))
          throw new ApiError(422, 'authoring_directory_conflict', 'The Antigravity authoring directory or config path overlaps a registered workspace.');
      }
      const taskRootPath = join(canonicalPath(this.store.workdirs), 'tasks');
      const taskRoot = existsSync(taskRootPath) ? canonicalPath(taskRootPath) : taskRootPath;
      if ([workingDirectory, mcpConfigPath].some(path => within(path, taskRoot) || within(taskRoot, path)))
        throw new ApiError(422, 'authoring_directory_conflict', 'The Antigravity authoring directory or config path overlaps the runtime-managed copied Map task area.');
    }
    const activeSince = new Date(Date.now() - 90_000).toISOString();
    this.store.run('DELETE FROM bridge_registrations WHERE last_seen_at < ?', activeSince);
    this.store.run(`INSERT INTO bridge_registrations(bridge_id,client_provider,working_directory,mcp_config_path,isolation_mechanism,last_seen_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(bridge_id) DO UPDATE SET client_provider=excluded.client_provider,working_directory=excluded.working_directory,
      mcp_config_path=excluded.mcp_config_path,isolation_mechanism=excluded.isolation_mechanism,last_seen_at=excluded.last_seen_at`,
    body.bridgeId, body.clientProvider, workingDirectory, mcpConfigPath, typeof body.isolationMechanism === 'string' ? body.isolationMechanism.slice(0, 120) : null, nowIso());
    return { bridgeId: body.bridgeId, clientProvider: body.clientProvider, workingDirectory, mcpConfigPath, ...this.runtimeIdentity() };
  }

  unregisterBridge(bridgeId) { this.store.run('DELETE FROM bridge_registrations WHERE bridge_id = ?', bridgeId); }

  workflowEtag(row, sha256 = this.store.artifactRow(row.snapshot_artifact_id).sha256) { return `"wf-${row.revision}-${sha256}"`; }

  savedWorkflowV3(row) {
    const saved = this.savedWorkflow(row);
    return { ...saved, revision: row.revision, etag: this.workflowEtag(row, saved.snapshotSha256) };
  }

  getWorkflowV3(workflowId) {
    const row = this.store.get("SELECT * FROM workflows WHERE id = ? AND kind = 'user'", workflowId);
    if (!row) throw new ApiError(404, 'not_found', `Workflow "${workflowId}" does not exist.`);
    return this.savedWorkflowV3(row);
  }

  draftEtag(row, digest = this.store.artifactRow(row.snapshot_artifact_id).sha256) { return `"draft-${row.revision}-${digest}"`; }

  draftBody(row) {
    const workflow = this.store.readJson(row.snapshot_artifact_id);
    const snapshot = this.store.artifactRow(row.snapshot_artifact_id);
    const { view, ...executionDefinition } = workflow;
    return { workflowId: row.workflow_id, workflow, revision: row.revision, etag: this.draftEtag(row, snapshot.sha256),
      snapshotSha256: snapshot.sha256, definitionDigest: snapshot.sha256, executionHash: canonicalHash(executionDefinition),
      sourcePublishedVersionId: row.source_published_version_id, validation: this.validateWorkflow(workflow), updatedAt: row.updated_at };
  }

  getWorkflowDraft(workflowId) {
    const row = this.store.get('SELECT * FROM workflow_drafts WHERE workflow_id = ?', workflowId);
    if (!row) throw new ApiError(404, 'draft_not_found', `Workflow "${workflowId}" has no editable Draft.`);
    return this.draftBody(row);
  }

  assertDraftPrecondition(workflowId, expectedEtag) {
    if (expectedEtag === null) {
      if (this.store.get('SELECT workflow_id FROM workflow_drafts WHERE workflow_id = ?', workflowId))
        throw new ApiError(412, 'precondition_failed', 'A Draft already exists.', [{ path: '/If-None-Match', message: 'Read the Draft and supply its current If-Match ETag.' }]);
      return;
    }
    if (typeof expectedEtag !== 'string') throw new ApiError(428, 'precondition_required', 'Supply If-None-Match: * to create a Draft or If-Match with the exact Draft ETag.');
    const current = this.store.get('SELECT * FROM workflow_drafts WHERE workflow_id = ?', workflowId);
    if (!current || this.draftEtag(current) !== expectedEtag)
      throw new ApiError(412, 'precondition_failed', current ? 'The Draft changed; reload it before saving or publishing.' : 'The Draft no longer exists.', current ? [{ path: '/If-Match', message: `Current Draft revision is ${current.revision}.` }] : []);
  }

  saveWorkflowDraft(workflowId, body, expectedEtag) {
    const issues = check(API_V4, 'writeDraft', body);
    if (issues.length) throw new ApiError(400, 'invalid_request', 'Request does not match writeDraft.', issues);
    if (body.workflow.workflowId !== workflowId) throw new ApiError(400, 'invalid_request', 'workflowId in the body must match the path.');
    const structural = structuralIssues(body.workflow);
    if (structural.length) throw new ApiError(422, 'validation_failed', 'The Draft does not match workflow.schema.json.', structural);
    if (expectedEtag !== null && typeof expectedEtag !== 'string') throw new ApiError(428, 'precondition_required', 'Supply If-None-Match: * to create a Draft or If-Match with the exact Draft ETag.');
    const payload = { workflowId, expectedEtag, workflow: body.workflow };
    return this.idempotent(`PUT /api/v4/workflows/${workflowId}/draft`, body.requestId, payload, () => {
      const logical = this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId);
      if (logical?.kind === 'system') throw new ApiError(409, 'conflict', `Workflow ID "${workflowId}" is reserved.`);
      this.assertDraftPrecondition(workflowId, expectedEtag);
      const draft = this.store.get('SELECT * FROM workflow_drafts WHERE workflow_id = ?', workflowId);
      const artifact = this.store.putBytes(canonicalBytes(body.workflow), 'application/json');
      const now = nowIso();
      const revision = draft ? draft.revision + 1 : logical ? logical.revision + 1 : 1;
      if (logical) this.store.run('UPDATE workflows SET snapshot_artifact_id = ?, revision = ?, updated_at = ? WHERE id = ?', artifact.artifactId, revision, now, workflowId);
      else this.store.run("INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at,kind,revision) VALUES(?,?,?,?,'user',?)", workflowId, artifact.artifactId, now, now, revision);
      if (draft) this.store.run('UPDATE workflow_drafts SET revision = ?, snapshot_artifact_id = ?, updated_at = ? WHERE workflow_id = ?', revision, artifact.artifactId, now, workflowId);
      else this.store.run('INSERT INTO workflow_drafts(workflow_id,revision,snapshot_artifact_id,source_published_version_id,created_at,updated_at) VALUES(?,?,?,NULL,?,?)', workflowId, revision, artifact.artifactId, now, now);
      const eventId = randomUUID();
      this.store.run('INSERT INTO workflow_changes(event_id,workflow_id,revision,snapshot_sha256,request_id,created_at) VALUES(?,?,?,?,?,?)', eventId, workflowId, revision, artifact.sha256, body.requestId, now);
      return this.draftBody(this.store.get('SELECT * FROM workflow_drafts WHERE workflow_id = ?', workflowId));
    }, () => {
      const row = this.store.get('SELECT * FROM workflow_changes WHERE request_id = ?', body.requestId);
      if (row) queueMicrotask(() => this.store.emit('workflow-change', this.workflowChangeBody(row)));
    });
  }

  deriveWorkflowDraft(workflowId, version, body, expectedEtag) {
    const issues = check(API_V4, 'deriveDraft', body);
    if (issues.length) throw new ApiError(400, 'invalid_request', 'Request does not match deriveDraft.', issues);
    const payload = { workflowId, version, expectedEtag };
    return this.idempotent(`POST /api/v4/workflows/${workflowId}/draft/from/${version}`, body.requestId, payload, () => {
      const logical = this.store.get('SELECT * FROM workflows WHERE id = ? AND kind = \'user\'', workflowId);
      if (!logical) throw new ApiError(404, 'not_found', `Workflow "${workflowId}" does not exist.`);
      const publication = this.workflowPublicationRow(workflowId, version);
      this.assertDraftPrecondition(workflowId, expectedEtag);
      const draft = this.store.get('SELECT * FROM workflow_drafts WHERE workflow_id = ?', workflowId);
      const now = nowIso();
      const revision = draft ? draft.revision + 1 : logical.revision + 1;
      const workflow = this.store.readJson(publication.snapshot_artifact_id);
      if (draft) this.store.run('UPDATE workflow_drafts SET revision = ?, snapshot_artifact_id = ?, source_published_version_id = ?, updated_at = ? WHERE workflow_id = ?', revision, publication.snapshot_artifact_id, publication.id, now, workflowId);
      else this.store.run('INSERT INTO workflow_drafts(workflow_id,revision,snapshot_artifact_id,source_published_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', workflowId, revision, publication.snapshot_artifact_id, publication.id, now, now);
      this.store.run('UPDATE workflows SET snapshot_artifact_id = ?, revision = ?, updated_at = ? WHERE id = ?', publication.snapshot_artifact_id, revision, now, workflowId);
      const eventId = randomUUID();
      this.store.run('INSERT INTO workflow_changes(event_id,workflow_id,revision,snapshot_sha256,request_id,created_at) VALUES(?,?,?,?,?,?)', eventId, workflowId, revision, publication.definition_digest, body.requestId, now);
      return this.draftBody(this.store.get('SELECT * FROM workflow_drafts WHERE workflow_id = ?', workflowId));
    }, () => {
      const row = this.store.get('SELECT * FROM workflow_changes WHERE request_id = ?', body.requestId);
      if (row) queueMicrotask(() => this.store.emit('workflow-change', this.workflowChangeBody(row)));
    });
  }

  validateWorkflowDraft(workflowId, expectedEtag) {
    if (typeof expectedEtag !== 'string') throw new ApiError(428, 'precondition_required', 'Supply If-Match with the exact Draft ETag to validate a Draft revision.');
    const saved = this.getWorkflowDraft(workflowId);
    if (saved.etag !== expectedEtag) throw new ApiError(412, 'precondition_failed', 'The Draft changed; reload it before validating.', [{ path: '/If-Match', message: `Current Draft revision is ${saved.revision}.` }]);
    return { workflowId, revision: saved.revision, etag: saved.etag, definitionDigest: saved.definitionDigest, validation: saved.validation };
  }

  publishWorkflowDraft(workflowId, body, expectedEtag) {
    const issues = check(API_V4, 'publishDraft', body);
    if (issues.length) throw new ApiError(400, 'invalid_request', 'Request does not match publishDraft.', issues);
    if (typeof expectedEtag !== 'string') throw new ApiError(428, 'precondition_required', 'Supply If-Match with the exact Draft ETag to publish.');
    const payload = { workflowId, expectedEtag };
    return this.idempotent(`POST /api/v4/workflows/${workflowId}/publish`, body.requestId, payload, () => {
      const draftRow = this.store.get('SELECT * FROM workflow_drafts WHERE workflow_id = ?', workflowId);
      if (!draftRow) throw new ApiError(404, 'draft_not_found', `Workflow "${workflowId}" has no editable Draft.`);
      if (this.draftEtag(draftRow) !== expectedEtag) throw new ApiError(412, 'precondition_failed', 'The Draft changed; reload and validate the current revision before publishing.', [{ path: '/If-Match', message: `Current Draft revision is ${draftRow.revision}.` }]);
      const workflow = this.store.readJson(draftRow.snapshot_artifact_id);
      const validation = this.validateWorkflow(workflow);
      if (!validation.valid) throw new ApiError(422, 'validation_failed', 'The Draft is not suitable for Publication.', validation.issues);
      const snapshot = this.store.artifactRow(draftRow.snapshot_artifact_id);
      const { view, ...executionDefinition } = workflow;
      const latest = this.store.get('SELECT MAX(version) AS version FROM workflow_publications WHERE workflow_id = ?', workflowId).version || 0;
      const version = latest + 1, publishedAt = nowIso(), publicationId = randomUUID();
      const authorityPolicyVersion = workflow.judgePolicy?.version || LEGACY_AUTHORITY_POLICY;
      this.store.run(`INSERT INTO workflow_publications(
        id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,authority_policy_version,
        provenance,runnable,validation_json,source_draft_revision,created_at
      ) VALUES(?,?,?,?,?,?,?,'owner-publication',1,?,?,?)`, publicationId, workflowId, version, snapshot.id, snapshot.sha256,
      canonicalHash(executionDefinition), authorityPolicyVersion, canonicalize(validation), draftRow.revision, publishedAt);
      this.store.run('UPDATE workflows SET snapshot_artifact_id = ?, revision = ?, updated_at = ? WHERE id = ?', snapshot.id, draftRow.revision, publishedAt, workflowId);
      // Cache identity follows the executable definition: publication, not editing, retires or adds Cache incarnations.
      this.syncCacheNodeIncarnations(workflowId, workflow);
      this.store.run('UPDATE workflow_drafts SET source_published_version_id = ? WHERE workflow_id = ?', publicationId, workflowId);
      const eventId = randomUUID();
      this.store.run('INSERT INTO workflow_changes(event_id,workflow_id,revision,snapshot_sha256,request_id,created_at) VALUES(?,?,?,?,?,?)', eventId, workflowId, draftRow.revision, snapshot.sha256, body.requestId, publishedAt);
      const result = this.workflowPublicationBody(this.store.get('SELECT * FROM workflow_publications WHERE id = ?', publicationId));
      return result;
    }, () => {
      const row = this.store.get('SELECT * FROM workflow_changes WHERE request_id = ?', body.requestId);
      if (row) queueMicrotask(() => this.store.emit('workflow-change', this.workflowChangeBody(row)));
    });
  }

  workflowPublicationRow(workflowId, version) {
    if (!Number.isInteger(version) || version < 1) throw new ApiError(404, 'published_version_not_found', 'The Published Version does not exist.');
    const row = this.store.get('SELECT * FROM workflow_publications WHERE workflow_id = ? AND version = ?', workflowId, version);
    if (!row) throw new ApiError(404, 'published_version_not_found', `Published Version ${version} of "${workflowId}" does not exist.`);
    return row;
  }

  workflowPublicationBody(row) {
    const workflow = this.store.readJson(row.snapshot_artifact_id);
    return { workflowId: row.workflow_id, publishedVersionId: row.id, version: row.version, workflow,
      definitionDigest: row.definition_digest, snapshotSha256: this.store.artifactRow(row.snapshot_artifact_id).sha256,
      executionHash: row.execution_hash, authorityPolicyVersion: row.authority_policy_version, provenance: row.provenance,
      runnable: Boolean(row.runnable), validation: parseStrictJson(row.validation_json), sourceDraftRevision: row.source_draft_revision,
      publishedAt: row.created_at, etag: `"publication-${row.version}-${row.definition_digest}"` };
  }

  listWorkflowPublications(workflowId, { limit, cursor } = {}) {
    if (!this.store.get("SELECT id FROM workflows WHERE id = ? AND kind = 'user'", workflowId)) throw new ApiError(404, 'not_found', `Workflow "${workflowId}" does not exist.`);
    return this.page({ collection: `workflow-publications:${workflowId}`, table: 'workflow_publications', filters: { workflowId },
      where: ['workflow_id = ?'], params: [workflowId], limit, cursor, map: row => {
        const { workflow, ...summary } = this.workflowPublicationBody(row); return summary;
      } });
  }

  getWorkflowPublication(workflowId, version) { return this.workflowPublicationBody(this.workflowPublicationRow(workflowId, version)); }

  getLatestWorkflowPublication(workflowId) {
    const row = this.store.get('SELECT * FROM workflow_publications WHERE workflow_id = ? ORDER BY version DESC LIMIT 1', workflowId);
    if (!row) throw new ApiError(404, 'published_version_not_found', `Workflow "${workflowId}" has no Published Version.`);
    return this.workflowPublicationBody(row);
  }

  resolveRunnablePublicationBySnapshot(workflowId, snapshotSha256) {
    const row = this.store.get(`SELECT p.* FROM workflow_publications p
      JOIN artifacts a ON a.id = p.snapshot_artifact_id
      WHERE p.workflow_id = ? AND a.sha256 = ? AND p.runnable = 1
      ORDER BY p.version DESC LIMIT 1`, workflowId, snapshotSha256);
    if (!row) throw new ApiError(404, 'published_version_not_found', 'No Runnable Published Version matches the Host-authorized workflow snapshot.');
    return row;
  }

  listWorkflowLifecycle({ limit, cursor } = {}) {
    return this.page({ collection: 'workflow-lifecycle', table: 'workflows', filters: {}, where: ["kind = 'user'"], limit, cursor, map: row => {
      const draft = this.store.get('SELECT revision FROM workflow_drafts WHERE workflow_id = ?', row.id);
      const latest = this.store.get('SELECT id,version,definition_digest,runnable FROM workflow_publications WHERE workflow_id = ? ORDER BY version DESC LIMIT 1', row.id);
      return { workflowId: row.id, draftRevision: draft?.revision ?? null, publishedVersionId: latest?.id ?? null,
        latestPublishedVersion: latest?.version ?? null, definitionDigest: latest?.definition_digest ?? null,
        runnable: latest ? Boolean(latest.runnable) : false, createdAt: row.created_at, updatedAt: row.updated_at };
    } });
  }

  listWorkflowsV3({ limit, cursor } = {}) {
    return this.page({ collection: 'workflows-v3', table: 'workflows', filters: {}, where: ["kind = 'user'"], limit, cursor, map: row => {
      const saved = this.savedWorkflow(row);
      return { workflowId: row.id, revision: row.revision, snapshotSha256: saved.snapshotSha256, executionHash: saved.executionHash, createdAt: row.created_at, updatedAt: row.updated_at };
    } });
  }

  syncCacheNodeIncarnations(workflowId, workflow) {
    const cacheNodes = new Set(allNodesDeep(workflow.nodes).filter(node => node.type === 'cache').map(node => node.id));
    const active = this.store.all('SELECT node_id, incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND active = 1', workflowId);
    for (const row of active) if (!cacheNodes.has(row.node_id))
      this.store.run('UPDATE cache_node_incarnations SET active = 0, retired_at = ? WHERE workflow_id = ? AND node_id = ? AND incarnation_id = ?', nowIso(), workflowId, row.node_id, row.incarnation_id);
    for (const nodeId of cacheNodes) {
      const row = this.store.get('SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND node_id = ? AND active = 1', workflowId, nodeId);
      if (!row) this.store.run('INSERT INTO cache_node_incarnations(workflow_id,node_id,incarnation_id,active,created_at) VALUES(?,?,?,1,?)', workflowId, nodeId, randomUUID(), nowIso());
    }
  }

  saveWorkflowV3(workflowId, body) {
    this.refuseHostMutation('Workflow revision');
    if (!body || !Object.hasOwn(body, 'expectedEtag') || body.expectedEtag === undefined)
      throw new ApiError(428, 'precondition_required', 'Supply expectedEtag from a workflow read, or null for create-only.');
    const issues = check(API_V3, 'saveWorkflow', body);
    if (issues.length) throw new ApiError(400, 'invalid_request', 'Request does not match saveWorkflow.', issues);
    const workflow = body.workflow;
    if (workflow.workflowId !== workflowId) throw new ApiError(400, 'invalid_request', 'workflowId in the body must match the path.');
    const structural = structuralIssues(workflow);
    if (structural.length) throw new ApiError(422, 'validation_failed', 'The workflow does not match workflow.schema.json.', structural);
    const expectedEtag = body.expectedEtag;
    const payload = { workflowId, expectedEtag, workflow };
    return this.idempotent(`PUT /api/v3/workflows/${workflowId}`, body.requestId, payload, () => {
      const existing = this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId);
      if (existing?.kind === 'system') throw new ApiError(409, 'conflict', `Workflow ID "${workflowId}" is reserved.`);
      if (expectedEtag === null) {
        if (existing) throw new ApiError(412, 'precondition_failed', 'A workflow with this ID already exists.', [{ path: '/expectedEtag', message: `Current ETag is ${this.workflowEtag(existing)}.` }]);
      } else {
        if (expectedEtag === undefined) throw new ApiError(428, 'precondition_required', 'Supply expectedEtag from a workflow read, or null for create-only.');
        if (!existing || this.workflowEtag(existing) !== expectedEtag)
          throw new ApiError(412, 'precondition_failed', existing ? `The workflow changed; current revision is ${existing.revision}.` : 'The workflow no longer exists.', existing ? [{ path: '/expectedEtag', message: `Current ETag is ${this.workflowEtag(existing)}.` }] : []);
      }
      const artifact = this.store.putBytes(canonicalBytes(workflow), 'application/json');
      const now = nowIso();
      const revision = existing ? existing.revision + 1 : 1;
      if (existing) this.store.run('UPDATE workflows SET snapshot_artifact_id = ?, revision = ?, updated_at = ? WHERE id = ?', artifact.artifactId, revision, now, workflowId);
      else this.store.run('INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at,kind,revision) VALUES(?,?,?,? ,\'user\',?)', workflowId, artifact.artifactId, now, now, revision);
      this.syncCacheNodeIncarnations(workflowId, workflow);
      const eventId = randomUUID();
      this.store.run('INSERT INTO workflow_changes(event_id,workflow_id,revision,snapshot_sha256,request_id,created_at) VALUES(?,?,?,?,?,?)', eventId, workflowId, revision, artifact.sha256, body.requestId, now);
      return this.savedWorkflowV3(this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId));
    }, () => {
      const row = this.store.get('SELECT * FROM workflow_changes WHERE request_id = ?', body.requestId);
      if (row) queueMicrotask(() => this.store.emit('workflow-change', this.workflowChangeBody(row)));
    });
  }

  workflowChangeBody(row) {
    return { sequence: row.sequence, eventId: row.event_id, workflowId: row.workflow_id, revision: row.revision, snapshotSha256: row.snapshot_sha256, requestId: row.request_id, createdAt: row.created_at };
  }

  workflowChanges({ after = 0, limit = 100 } = {}) {
    if (!Number.isInteger(after) || after < 0) throw new ApiError(400, 'invalid_request', 'after must be a nonnegative integer.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 200.');
    const bounds = this.store.get('SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM workflow_changes');
    const latest = bounds.last || 0;
    if (after > latest) throw new ApiError(409, 'conflict', 'The workflow-change cursor is beyond the latest committed event.');
    if (bounds.first && after < bounds.first - 1) return { items: [], nextCursor: null, cursor: latest, resyncRequired: true };
    const rows = this.store.all('SELECT * FROM workflow_changes WHERE sequence > ? ORDER BY sequence LIMIT ?', after, limit + 1);
    const items = rows.slice(0, limit).map(row => this.workflowChangeBody(row));
    return { items, nextCursor: rows.length > limit ? items.at(-1).sequence : null, cursor: latest, resyncRequired: false };
  }

  putWorkflow(workflowId, text, { kind = 'user' } = {}) {
    // Only the internal Context chat uses this unversioned system snapshot path.
    if (kind !== 'system' || workflowId !== CHAT_WORKFLOW)
      throw new ApiError(428, 'precondition_required', 'User workflows require a v3 request ID and an explicit save precondition.');
    let workflow;
    try { workflow = typeof text === 'string' ? parseStrictJson(text) : text; }
    catch (error) { throw new ApiError(400, 'invalid_request', error.message); }
    const structural = structuralIssues(workflow);
    if (structural.length) throw new ApiError(422, 'validation_failed', 'The workflow does not match workflow.schema.json.', structural);
    if (workflow.workflowId !== workflowId) throw new ApiError(400, 'invalid_request', 'workflowId in the body must match the path.');
    const existing = this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId);
    if ((existing?.kind || (workflowId === CHAT_WORKFLOW ? 'system' : 'user')) !== kind) throw new ApiError(409, 'conflict', `Workflow ID "${workflowId}" is reserved.`);
    const artifact = this.store.putBytes(canonicalBytes(workflow), 'application/json');
    const now = nowIso();
    if (existing) this.store.run('UPDATE workflows SET snapshot_artifact_id = ?, updated_at = ? WHERE id = ?', artifact.artifactId, now, workflowId);
    else this.store.run('INSERT INTO workflows(id, snapshot_artifact_id, created_at, updated_at, kind) VALUES (?, ?, ?, ?, ?)', workflowId, artifact.artifactId, now, now, kind);
    return this.savedWorkflow(this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId));
  }

  getWorkflow(workflowId) {
    const row = this.store.get(`SELECT * FROM workflows WHERE id = ? AND kind = 'user'`, workflowId);
    if (!row) throw new ApiError(404, 'not_found', `Workflow "${workflowId}" does not exist.`);
    return this.savedWorkflow(row);
  }

  listWorkflows({ limit, cursor } = {}) {
    return this.page({ collection: 'workflows', table: 'workflows', filters: {}, where: [`kind = 'user'`], limit, cursor, map: row => {
      const saved = this.savedWorkflow(row);
      return { workflowId: row.id, snapshotSha256: saved.snapshotSha256, executionHash: saved.executionHash, createdAt: row.created_at, updatedAt: row.updated_at };
    } });
  }

  // ---------- Cache pins ----------
  // The executable definition of a user workflow is its latest Published Version. Drafts are never executed, so cache
  // identity and pins are defined by publications only.
  latestExecutableWorkflow(workflowId) {
    const row = this.store.get('SELECT snapshot_artifact_id FROM workflow_publications WHERE workflow_id = ? ORDER BY version DESC LIMIT 1', workflowId);
    return row ? this.store.readJson(row.snapshot_artifact_id) : null;
  }

  pinsFor(workflowId) {
    return Object.fromEntries(this.store.all(`SELECT p.* FROM cache_pins p JOIN cache_node_incarnations c
      ON c.workflow_id = p.workflow_id AND c.node_id = p.node_id AND c.incarnation_id = p.incarnation_id AND c.active = 1
      WHERE p.workflow_id = ?`, workflowId)
      .map(row => [row.node_id, { value: parseStrictJson(row.value_json), sourceRunId: row.source_run_id, sourceAttemptId: row.source_attempt_id, fingerprint: row.fingerprint, pinnedAt: row.pinned_at, incarnationId: row.incarnation_id }]));
  }

  listPins(workflowId) {
    this.getWorkflow(workflowId);
    const executable = this.latestExecutableWorkflow(workflowId);
    const current = executable ? this.cacheFingerprints(executable, this.pinsFor(workflowId)) : {};
    const active = this.pinsFor(workflowId);
    const rows = this.store.all('SELECT * FROM cache_pins WHERE workflow_id = ?', workflowId);
    return { pins: rows.map(row => {
      const pin = active[row.node_id] || { value: parseStrictJson(row.value_json), sourceRunId: row.source_run_id, sourceAttemptId: row.source_attempt_id, fingerprint: row.fingerprint, pinnedAt: row.pinned_at };
      const orphaned = !active[row.node_id];
      return { nodeId: row.node_id, value: pin.value, sourceRunId: pin.sourceRunId, sourceAttemptId: pin.sourceAttemptId,
        fingerprint: pin.fingerprint, sourceChanged: orphaned || current[row.node_id] !== pin.fingerprint, orphaned, pinnedAt: pin.pinnedAt };
    }) };
  }

  // Fingerprint of each Cache's producer side, used to report a changed source.
  cacheFingerprints(workflow, pins) {
    const result = {};
    const visit = graph => {
      const prints = fingerprints(graph, pins);
      for (const node of graph.nodes) {
        if (node.type === 'cache') { const edge = graph.edges.find(item => item.target.nodeId === node.id); result[node.id] = edge && edge.source.nodeId !== INPUT ? prints[edge.source.nodeId] : canonicalHash({ boundary: edge?.source.port }); }
        if (node.type === 'loop') visit(node.config.body);
      }
    };
    visit(workflow);
    return result;
  }

  freezeCache(workflowId, nodeId, body) {
    this.validateBody('freezeCacheRequest', body);
    const executable = this.latestExecutableWorkflow(workflowId);
    if (!executable) throw new ApiError(404, 'published_version_not_found', `Workflow "${workflowId}" has no Published Version to pin against.`);
    const node = allNodesDeep(executable.nodes).find(item => item.id === nodeId);
    if (node?.type !== 'cache') throw new ApiError(404, 'not_found', `"${nodeId}" is not a Cache node of "${workflowId}".`);
    const run = this.requireRun(body.runId);
    if (run.workflow_id !== workflowId) throw new ApiError(409, 'conflict', 'The run belongs to another workflow.');
    if (body.nodeInstanceId !== nodeId) throw new ApiError(409, 'conflict', 'Pin an outer Cache instance (scoped body instances are pinned from their node ID).');
    const attempt = this.latestAttempt(run.id, body.nodeInstanceId);
    if (!attempt || attempt.state !== 'succeeded' || !attempt.outputs_artifact_id) throw new ApiError(409, 'conflict', 'Only a succeeded Cache attempt can be pinned.');
    const value = this.store.readJson(attempt.outputs_artifact_id).values.value;
    this.storePin(executable, nodeId, value, run.id, attempt.id);
    return this.listPins(workflowId);
  }

  storePin(workflow, nodeId, value, runId, attemptId) {
    this.syncCacheNodeIncarnations(workflow.workflowId, workflow);
    const incarnation = this.store.get('SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND node_id = ? AND active = 1', workflow.workflowId, nodeId);
    if (!incarnation) throw new ApiError(409, 'conflict', `Cache node "${nodeId}" has no active identity.`);
    const pins = { ...this.pinsFor(workflow.workflowId), [nodeId]: { value } };
    const fingerprint = this.cacheFingerprints(workflow, pins)[nodeId];
    this.store.run(`INSERT INTO cache_pins(workflow_id, node_id, value_json, source_run_id, source_attempt_id, fingerprint, pinned_at, incarnation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, node_id) DO UPDATE SET value_json = excluded.value_json, source_run_id = excluded.source_run_id, source_attempt_id = excluded.source_attempt_id, fingerprint = excluded.fingerprint, pinned_at = excluded.pinned_at, incarnation_id = excluded.incarnation_id`,
    workflow.workflowId, nodeId, canonicalize(value), runId, attemptId, fingerprint, nowIso(), incarnation.incarnation_id);
  }

  deleteCachePin(workflowId, nodeId) {
    this.getWorkflow(workflowId);
    this.store.run('DELETE FROM cache_pins WHERE workflow_id = ? AND node_id = ?', workflowId, nodeId);
    return this.listPins(workflowId);
  }

  // ---------- Context bindings ----------
  bindingRecord(row) { return this.store.readJson(row.binding_artifact_id); }
  bindingBody(row) {
    const record = this.bindingRecord(row);
    return { bindingId: row.id, provider: row.provider, workspaceId: row.workspace_id, state: row.state, model: record.model ?? null, configurationHash: row.configuration_hash, bindingSha256: this.store.artifactRow(row.binding_artifact_id).sha256 };
  }

  listBindings(workspaceId) {
    this.requireWorkspace(workspaceId);
    return { bindings: this.store.all('SELECT * FROM context_bindings WHERE workspace_id = ? ORDER BY updated_at DESC', workspaceId).map(row => this.bindingBody(row)) };
  }

  writeBinding(row, changes) {
    const record = { ...this.bindingRecord(row), ...changes, schemaVersion: 1, bindingId: row.id };
    const artifact = this.store.putJson(record);
    const nativeHash = record.nativeSessionId ? sha256(Buffer.from(`${row.provider}:${record.nativeSessionId}`)) : null;
    this.store.run(`UPDATE context_bindings SET state = ?, binding_artifact_id = ?, native_session_hash = ?, account_identity = ?, configuration_hash = ?, updated_at = ? WHERE id = ?`,
      record.state, artifact.artifactId, nativeHash, record.accountIdentity, record.configurationHash, nowIso(), row.id);
    return this.store.get('SELECT * FROM context_bindings WHERE id = ?', row.id);
  }

  createBinding(runId, workspace, provider, contextNodeId, createdAt = nowIso()) {
    const bindingId = randomUUID();
    const record = { schemaVersion: 1, bindingId, provider, workspaceId: workspace.id, cwdIdentity: workspace.cwd_identity, state: 'unbound',
      accountIdentity: 'pending', configurationHash: '0'.repeat(64), nativeSessionId: null, model: null, origin: { runId, contextNodeId } };
    const artifact = this.store.putJson(record);
    this.store.run(`INSERT INTO context_bindings(id, provider, workspace_id, account_identity, cwd_identity, configuration_hash, native_session_hash, binding_artifact_id, state, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, 'unbound', ?)`,
      bindingId, provider, workspace.id, workspace.cwd_identity, record.configurationHash, artifact.artifactId, createdAt);
    return bindingId;
  }

  acknowledgeBinding(bindingId, body) {
    this.validateBody('acknowledgeContext', body);
    return this.idempotent(`POST /context-bindings/${bindingId}/acknowledge`, body.requestId, body, () => this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM context_bindings WHERE id = ?', bindingId);
      if (!row) throw new ApiError(404, 'not_found', 'Unknown Context binding.');
      if (this.locks.has(`binding:${bindingId}`) || row.state === 'writing') throw new ApiError(409, 'conflict', 'The binding has an active writer.');
      if (this.store.artifactRow(row.binding_artifact_id).sha256 !== body.observedBindingSha256) throw new ApiError(409, 'conflict', 'The binding changed since it was observed.');
      if (row.state === 'unavailable') throw new ApiError(409, 'context_unavailable', 'An unavailable session cannot be made available by acknowledgement.');
      if (row.state !== 'needs_review') throw new ApiError(409, 'conflict', `Only needs_review bindings can be acknowledged (state is ${row.state}).`);
      const to = this.bindingRecord(row).nativeSessionId ? 'ready' : 'unbound';
      return this.bindingBody(this.writeBinding(row, { state: to, acknowledgedAt: nowIso(), acknowledgedFrom: body.observedBindingSha256 }));
    }));
  }

  // Manual Context chat: a run of kind "chat" over a generated core-v1 workflow.
  sendChat(bindingId, body) {
    this.validateBody('chatRequest', body);
    return this.idempotent(`POST /context-bindings/${bindingId}/messages`, body.requestId, body, () => {
      const binding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', bindingId);
      if (!binding) throw new ApiError(404, 'not_found', 'Unknown Context binding.');
      if (binding.workspace_id !== body.workspaceId) throw new ApiError(409, 'conflict', 'The binding belongs to another workspace.');
      if (binding.state !== 'ready' || !this.bindingRecord(binding).nativeSessionId) throw new ApiError(422, 'context_unavailable', `Chat needs a ready binding with a native session (state is ${binding.state}).`);
      const workflow = {
        schemaVersion: 1, workflowId: CHAT_WORKFLOW, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
        nodes: [
          { id: 'message', type: 'text', config: { value: body.prompt } },
          { id: 'conversation', type: 'context', config: { provider: binding.provider, mode: 'continue', bindingId } },
          { id: 'reply', type: 'agent', config: { provider: binding.provider, model: body.model, effort: resolveEffort(body.effort), contextId: 'conversation', timeoutSeconds: body.timeoutSeconds ?? 600, output: { format: 'text' } } },
          { id: 'transcript', type: 'result-viewer', config: {} },
        ],
        edges: [
          { id: 'message-reply', source: { nodeId: 'message', port: 'text' }, target: { nodeId: 'reply', port: 'prompt' } },
          { id: 'reply-transcript', source: { nodeId: 'reply', port: 'text' }, target: { nodeId: 'transcript', port: 'value' } },
        ],
        after: [],
      };
      const saved = this.putWorkflow(CHAT_WORKFLOW, workflow, { kind: 'system' });
      const snapshot = this.store.artifactRow(this.store.get('SELECT snapshot_artifact_id FROM workflows WHERE id = ?', CHAT_WORKFLOW).snapshot_artifact_id);
      if (snapshot.sha256 !== saved.snapshotSha256) throw new Error('Chat snapshot mismatch.');
      this.refuseUnpermittedRun('A chat turn');
      return this.captureRun({ workflow, snapshot, workspace: this.requireWorkspace(body.workspaceId), kind: 'chat', options: {}, requestId: body.requestId });
    }, () => queueMicrotask(() => this.startRun()));
  }

  // ---------- Run queries ----------
  runBody(row) {
    const publication = row.published_version_id ? this.store.get('SELECT id,version,definition_digest,authority_policy_version FROM workflow_publications WHERE id = ?', row.published_version_id) : null;
    return { runId: row.id, workflowId: row.workflow_id, workflowSnapshot: { artifactId: row.workflow_snapshot_artifact_id, sha256: this.store.artifactRow(row.workflow_snapshot_artifact_id).sha256 },
      executionHash: row.execution_hash, state: row.state, lastSequence: row.last_sequence, createdAt: row.created_at, workspaceId: row.workspace_id, kind: row.kind,
      publishedVersion: publication ? { publishedVersionId: publication.id, version: publication.version, definitionDigest: publication.definition_digest, authorityPolicyVersion: publication.authority_policy_version } : null,
      controlMode: this.controlModeOf(row.id) };
  }
  requireRun(runId) {
    const row = this.store.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!row) throw new ApiError(404, 'not_found', `Run "${runId}" does not exist.`);
    return row;
  }

  latestAttempts(runId) {
    return this.store.all(`SELECT a.*, n.node_id FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id
      WHERE a.run_id = ? AND a.ordinal = (SELECT MAX(b.ordinal) FROM attempts b WHERE b.run_id = a.run_id AND b.node_instance_id = a.node_instance_id) ORDER BY n.rowid`, runId);
  }
  latestAttempt(runId, instanceId) {
    return this.store.get('SELECT * FROM attempts WHERE run_id = ? AND node_instance_id = ? ORDER BY ordinal DESC LIMIT 1', runId, instanceId);
  }

  runSnapshot(runId) {
    const row = this.requireRun(runId);
    const instances = this.latestAttempts(runId).map(item => ({ nodeInstanceId: item.node_instance_id, nodeId: item.node_id, state: item.state, attemptId: item.id, ordinal: item.ordinal,
      outputs: item.outputs_artifact_id ? { artifactId: item.outputs_artifact_id, sha256: this.store.artifactRow(item.outputs_artifact_id).sha256 } : null }));
    const contexts = this.store.all('SELECT * FROM run_context_bindings WHERE run_id = ? ORDER BY context_node_id', runId)
      .map(item => ({ contextNodeId: item.context_node_id, mode: item.mode, bindingId: item.binding_id }));
    const loops = this.store.all('SELECT * FROM loop_executions WHERE run_id = ? ORDER BY rowid', runId).map(item => ({
      loopNodeId: item.loop_node_id, state: item.state, iteration: item.iteration, maxIterations: item.max_iterations, maxActiveMinutes: item.max_active_minutes,
      activeMs: this.activeMs(runId, item.loop_node_id, item), pauseReason: item.pause_reason }));
    return { run: this.runBody(row), instances, contexts, loops, maps: this.mapSnapshots(runId), controlMode: this.controlModeOf(runId) };
  }

  listRuns({ workspaceId, state, kind, bindingId, limit, cursor } = {}) {
    if (workspaceId !== undefined) this.requireWorkspace(workspaceId);
    if (state !== undefined && !ACTIVE_RUN.has(state) && !TERMINAL_RUN.has(state)) throw new ApiError(400, 'invalid_request', `Unknown run state "${state}".`);
    if (kind !== undefined && !['workflow', 'chat'].includes(kind)) throw new ApiError(400, 'invalid_request', `Unknown run kind "${kind}".`);
    const filters = { workspaceId: workspaceId ?? null, state: state ?? null, kind: kind ?? null, bindingId: bindingId ?? null };
    const where = [], params = [];
    if (workspaceId !== undefined) { where.push('workspace_id = ?'); params.push(workspaceId); }
    if (state !== undefined) { where.push('state = ?'); params.push(state); }
    if (kind !== undefined) { where.push('kind = ?'); params.push(kind); }
    if (bindingId !== undefined) { where.push('id IN (SELECT run_id FROM run_context_bindings WHERE binding_id = ?)'); params.push(bindingId); }
    return this.page({ collection: 'runs', table: 'runs', filters, where, params, limit, cursor, map: row => this.runBody(row) });
  }

  // ---------- Run creation ----------
  async createRunAsync(body, options = {}) {
    if (typeof body?.publishedVersionId !== 'string' || typeof body?.workflowId !== 'string') return this.createRun(body, options);
    const publication = this.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
      JOIN artifacts a ON a.id = p.snapshot_artifact_id WHERE p.id = ? AND p.workflow_id = ?`, body.publishedVersionId, body.workflowId);
    if (!publication) return this.createRun(body, options);
    const workflow = this.store.readJson(publication.snapshot_artifact_id);
    if (!workflow.capabilities?.includes('protected-self-repair-v1')) return this.createRun(body, options);
    if (this.protectedSelfRepairAdmissionEnabled !== true)
      throw new ApiError(409, 'p5_admission_unavailable', 'P5 Run admission remains disabled until candidate capture, trusted verification, atomic P2/P4 acceptance and recovery are implemented and verified. No Run was captured.');
    const command = options.role === 'external' ? 'POST /runs/external' : 'POST /runs/direct';
    if (typeof body.requestId === 'string') {
      const replay = this.replayCommittedReceipt(command, body.requestId, body);
      if (replay.found) return replay.response;
    }
    const p5Admission = await this.prepareProtectedSelfRepairParentRunAdmission({ publication, workflow });
    try { return this.createRun(body, { ...options, p5Admission }); }
    finally { this.protectedSelfRepairRunAdmissions.delete(p5Admission); }
  }

  createRun(body, { role = 'first-party', clientLabel = null, controllerToken = null, hostAdmission = null, p5Admission = null } = {}) {
    // Replay exact commands committed before the Published-Version request shape existed.
    if (!hostAdmission && typeof body?.requestId === 'string') {
      const priorDirect = this.replayCommittedReceipt('POST /runs/direct', body.requestId, body, { ignoreDifferentCommand: true });
      if (priorDirect.found) return priorDirect.response;
      const priorExternal = this.replayCommittedReceipt('POST /runs/external', body.requestId, body, { ignoreDifferentCommand: true });
      if (priorExternal.found) return priorExternal.response;
    }
    this.validateBody('createRun', body);
    const external = role === 'external';
    if (this.recoveryBlocked) throw new ApiError(409, 'conflict', this.recoveryBlocked);
    if (this.closing) throw new ApiError(409, 'conflict', 'The runtime is shutting down.');
    if (external && !this.store.get('SELECT id FROM workspaces LIMIT 1')) throw new ApiError(409, 'workspace_required', 'Create a workspace in the Deszo window before requesting a run.');
    const command = external ? 'POST /runs/external' : 'POST /runs/direct';
    return this.idempotent(command, body.requestId, body, () => {
      const publication = this.store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p
        JOIN artifacts a ON a.id = p.snapshot_artifact_id WHERE p.id = ? AND p.workflow_id = ?`, body.publishedVersionId, body.workflowId);
      if (!publication) throw new ApiError(404, 'published_version_not_found', 'The requested Published Version does not exist for this workflow.');
      if (publication.definition_digest !== body.definitionDigest || publication.snapshot_sha256 !== body.workflowSnapshotSha256)
        throw new ApiError(409, 'conflict', 'The requested Published Version digest does not match the Run request.');
      if (!publication.runnable) throw new ApiError(409, 'published_version_not_runnable', 'This Published Version failed semantic validation and cannot start a Run.', parseStrictJson(publication.validation_json).issues || []);
      const workspace = this.requireWorkspace(body.workspaceId);
      const snapshot = this.store.artifactRow(publication.snapshot_artifact_id);
      const workflow = this.store.readJson(snapshot.id);
      if (workflow.capabilities?.includes('protected-self-repair-v1')
        && (!p5Admission || !this.protectedSelfRepairRunAdmissions.has(p5Admission) || p5Admission.kind !== 'p5-parent-run-admission'))
        throw new ApiError(409, 'p5_admission_unavailable', 'P5 publications require the asynchronous enrolled Parent admission path.');
      const currentValidation = this.validateWorkflow(workflow);
      if (!currentValidation.valid) throw new ApiError(409, 'published_version_not_runnable', 'The Published Version is no longer suitable for execution under current runtime conditions.', currentValidation.issues);
      this.assertWorkflowJudgeRuntimeAvailable(workflow);
      const settings = this.currentSettings().settings;
      // ADR-0006: a host permit replaces the confirmation pause only with a genuine admission made by this engine.
      if (body.hostPermitId && !this.isHostAdmission(hostAdmission, body.hostPermitId, 'run.approve')) throw new ApiError(403, 'host_admission_required', 'A run that names a host permit must be admitted by the Local Control Host first.');
      const hostAdmitted = Boolean(body.hostPermitId);
      const controlGrant = body.controlGrantId ? this.assertControlGrantForRun(body.controlGrantId, { workflowId: body.workflowId, workspaceId: body.workspaceId,
        snapshotSha256: body.workflowSnapshotSha256, controllerToken }) : null;
      if (external && settings.externalRunConfirmation && !hostAdmitted) {
        const createdAt = nowIso();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        this.store.run(`INSERT INTO external_run_requests(request_id,payload_sha256,request_json,workflow_id,workflow_snapshot_sha256,workspace_id,workspace_cwd_identity,client_label,state,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`, body.requestId, canonicalHash(body), canonicalize(body), body.workflowId, body.workflowSnapshotSha256, workspace.id, workspace.cwd_identity,
        typeof clientLabel === 'string' ? clientLabel.slice(0, 120) : null, createdAt, expiresAt);
        if (controlGrant) this.store.run('INSERT INTO run_request_controls(request_id, grant_id, controller_session_id) VALUES(?,?,?)', body.requestId, controlGrant.id, controlGrant.controller_session_id);
        return { status: 202, body: { outcome: 'confirmation_pending', requestId: body.requestId, statusPath: `/api/v2/run-requests/${body.requestId}` } };
      }
      if (!hostAdmitted) this.refuseUnpermittedRun('A run');
      const result = this.captureRun({ workflow, snapshot, workspace, kind: 'workflow', publication,
        options: { mode: body.mode || 'workflow', targets: body.targets, refreshCaches: body.refreshCaches || [] }, requestId: body.requestId, p5Admission });
      // The observer is armed here, inside the creating transaction and before the queued start.
      if (body.controlGrantId) this.bindControlGrant(body.controlGrantId, { runId: result.body.run.runId, workflowId: body.workflowId, workspaceId: body.workspaceId,
        snapshotSha256: body.workflowSnapshotSha256, controllerToken });
      if (body.controlGrantId) result.body.run = this.runBody(this.store.get('SELECT * FROM runs WHERE id = ?', result.body.run.runId));
      if (external) {
        const createdAt = nowIso();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        this.store.run(`INSERT INTO external_run_requests(request_id,payload_sha256,request_json,workflow_id,workflow_snapshot_sha256,workspace_id,workspace_cwd_identity,client_label,state,created_at,expires_at,run_id)
          VALUES(?,?,?,?,?,?,?,?,'approved',?,?,?)`, body.requestId, canonicalHash(body), canonicalize(body), body.workflowId, body.workflowSnapshotSha256, workspace.id, workspace.cwd_identity,
        typeof clientLabel === 'string' ? clientLabel.slice(0, 120) : null, createdAt, expiresAt, result.body.run.runId);
      }
      return result;
    }, () => queueMicrotask(() => this.startRun()));
  }

  expireRunRequests() {
    const now = nowIso();
    return this.store.transaction(() => this.store.run("UPDATE external_run_requests SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?", now).changes);
  }

  runRequestBody(row) {
    const control = this.store.get('SELECT grant_id FROM run_request_controls WHERE request_id = ?', row.request_id);
    return {
      requestId: row.request_id, workflowId: row.workflow_id, workspaceId: row.workspace_id,
      workflowSnapshotSha256: row.workflow_snapshot_sha256, clientLabel: row.client_label,
      state: row.state, createdAt: row.created_at, expiresAt: row.expires_at, runId: row.run_id,
      problem: row.problem_json ? parseStrictJson(row.problem_json) : null,
      controlGrantId: control?.grant_id ?? null, controlModeRequested: control ? 'supervised' : 'unsupervised',
    };
  }

  listRunRequests({ state = 'pending', limit = 50 } = {}) {
    this.expireRunRequests();
    if (!['pending', 'approved', 'denied', 'expired', 'all'].includes(state)) throw new ApiError(400, 'invalid_request', 'Unknown run-request state.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 100.');
    const rows = state === 'all'
      ? this.store.all('SELECT * FROM external_run_requests ORDER BY created_at DESC LIMIT ?', limit)
      : this.store.all('SELECT * FROM external_run_requests WHERE state = ? ORDER BY created_at DESC LIMIT ?', state, limit);
    return { items: rows.map(row => this.runRequestBody(row)), nextCursor: null };
  }

  getRunRequest(requestId) {
    this.expireRunRequests();
    const row = this.store.get('SELECT * FROM external_run_requests WHERE request_id = ?', requestId);
    if (!row) throw new ApiError(404, 'not_found', `Run request "${requestId}" does not exist.`);
    return this.runRequestBody(row);
  }

  listRunEvents(runId, { afterSequence = 0, limit = 100 } = {}) {
    const run = this.requireRun(runId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || afterSequence > run.last_sequence) throw new ApiError(400, 'invalid_request', 'afterSequence must be a valid nonnegative run-event cursor.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 200.');
    const rows = this.store.readEventsPage(runId, afterSequence, limit);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, nextCursor: more ? items.at(-1).sequence : null };
  }

  listFailureOutcomes(runId, { afterSequence = 0, limit = 100 } = {}) {
    const run = this.requireRun(runId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || afterSequence > run.last_sequence)
      throw new ApiError(400, 'invalid_request', 'afterSequence must be a valid nonnegative outcome cursor.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 200.');
    const rows = this.store.all(`SELECT outcome_json, first_sequence, latest_sequence FROM failure_outcomes
      WHERE run_id = ? AND latest_sequence > ? ORDER BY latest_sequence, outcome_id LIMIT ?`, runId, afterSequence, limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(row => ({ outcome: parseStrictJson(row.outcome_json),
      firstSequence: row.first_sequence, latestSequence: row.latest_sequence }));
    const legacyUntypedFailureCount = this.store.get(`SELECT COUNT(DISTINCT e.attempt_id) AS count FROM journal_events e
      WHERE e.run_id = ? AND e.attempt_id IS NOT NULL
        AND (e.event_type = 'attempt.error'
          OR (e.event_type = 'attempt.execution_evidence' AND json_extract(e.envelope_json, '$.payload.outcome')
            IN ('failed','spawn_failed','timed_out','interrupted','capture_failed','invalid_source'))
          OR (e.event_type = 'attempt.state_changed' AND json_extract(e.envelope_json, '$.payload.to')
            IN ('failed','canceled','interrupted','blocked')))
        AND NOT EXISTS (SELECT 1 FROM failure_outcomes f WHERE f.attempt_id = e.attempt_id)`, runId).count;
    return { items, nextCursor: more ? items.at(-1).latestSequence : null, cursor: run.last_sequence,
      legacyCoverage: { status: 'untyped', source: 'journal', untypedFailureCount: legacyUntypedFailureCount } };
  }

  artifactProvenance(artifactId) {
    const artifact = this.store.artifactRow(artifactId);
    if (!artifact) throw new ApiError(404, 'not_found', 'Unknown artifact.');
    const sources = this.store.all(`
      SELECT a.run_id,a.node_instance_id,a.id AS attempt_id,'inputs' AS source_kind,'[]' AS path_json FROM attempts a WHERE a.inputs_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'invocation','[]' FROM attempts a WHERE a.invocation_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'outputs','[]' FROM attempts a WHERE a.outputs_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'inputs',r.path_json FROM artifact_references r JOIN attempts a ON a.inputs_artifact_id = r.parent_artifact_id WHERE r.referenced_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'invocation',r.path_json FROM artifact_references r JOIN attempts a ON a.invocation_artifact_id = r.parent_artifact_id WHERE r.referenced_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'outputs',r.path_json FROM artifact_references r JOIN attempts a ON a.outputs_artifact_id = r.parent_artifact_id WHERE r.referenced_artifact_id = ?
      LIMIT 101`, artifactId, artifactId, artifactId, artifactId, artifactId, artifactId)
      .map(source => ({ runId: source.run_id, nodeInstanceId: source.node_instance_id, attemptId: source.attempt_id,
        sourceKind: source.source_kind, path: parseStrictJson(source.path_json) }));
    for (const run of this.store.all('SELECT id,workflow_snapshot_artifact_id FROM runs WHERE workflow_snapshot_artifact_id = ?', artifactId))
      sources.push({ runId: run.id, nodeInstanceId: null, attemptId: null, sourceKind: 'workflow_snapshot', path: [] });
    return { artifactId, sha256: artifact.sha256, byteSize: artifact.byte_size, mediaType: artifact.media_type, sources: sources.slice(0, 100) };
  }

  contextNodes(workflow) {
    const result = [];
    const visit = (nodes, loopId) => {
      for (const node of nodes) {
        if (node.type === 'context') result.push({ node, loopId });
        if (node.type === 'loop') visit(node.config.body.nodes, node.id);
      }
    };
    visit(workflow.nodes, null);
    return result;
  }

  // Compute the outer plan: planned node IDs, reused predecessors, frozen cuts and pins.
  planRun(workflow, workspace, { mode, targets, refreshCaches }) {
    const outer = new Map(workflow.nodes.map(node => [node.id, node]));
    const deep = allNodesDeep(workflow.nodes);
    for (const id of refreshCaches) if (deep.find(node => node.id === id)?.type !== 'cache') throw new ApiError(422, 'validation_failed', `refreshCaches names "${id}", which is not a Cache node.`);
    for (const id of targets || []) if (!outer.has(id) || outer.get(id).type === 'context') throw new ApiError(422, 'validation_failed', `Target "${id}" is not an executable node of the outer workflow.`);
    if (workflow.judgePolicy && (targets || []).includes(workflow.judgePolicy.judgeNodeId))
      throw new ApiError(422, 'validation_failed', 'The designated Judge can only be planned by P4 attention admission.', [{ path: '/targets', message: 'Ordinary Run modes cannot target the designated Judge.' }]);
    const pins = this.pinsFor(workflow.workflowId);
    const frozen = new Set(deep.filter(node => node.type === 'cache' && node.config.mode === 'frozen' && !refreshCaches.includes(node.id)).map(node => node.id));
    for (const id of frozen) {
      if (!pins[id]) throw new ApiError(422, 'validation_failed', `Frozen Cache "${id}" has no pin. Run it live and pin its value first.`, [{ path: id, message: 'missing pin' }]);
      try { this.store.verifyRef(pins[id].value.artifact); }
      catch { throw new ApiError(422, 'validation_failed', `The pin of Frozen Cache "${id}" failed digest verification.`); }
    }
    const viewers = workflow.nodes.filter(node => node.type === 'result-viewer').map(node => node.id);
    const reused = new Map();
    let planned;
    if (mode === 'node') {
      planned = new Set(targets);
      const target = targets[0];
      const predecessors = new Set([...workflow.edges.filter(edge => edge.target.nodeId === target).map(edge => edge.source.nodeId), ...workflow.after.filter(pair => pair.after === target).map(pair => pair.before)]);
      if (frozen.has(target)) predecessors.clear();
      const current = fingerprints(workflow, pins);
      for (const id of predecessors) {
        const source = this.reuseSource(workflow, workspace.id, id, current[id]);
        if (!source) throw new ApiError(422, 'validation_failed', `Run Node needs a committed, current output of "${id}"; none matches the current definition. Run the branch instead.`, [{ path: `/nodes/${id}`, message: 'missing or stale input' }]);
        reused.set(id, source);
      }
    } else {
      planned = requiredSet(workflow, mode === 'branch' ? targets : viewers, frozen);
    }
    // Context prerequisites: a planned writer cannot stand in for an unplanned or reused one.
    const users = new Map();
    const note = (contextId, outerNode, agent) => { if (!users.has(contextId)) users.set(contextId, []); users.get(contextId).push({ outerNode, agent }); };
    const walk = (nodes, outerNode) => { for (const node of nodes) { const owner = outerNode || node.id; if (node.type === 'agent' && node.config.contextId) note(node.config.contextId, owner, node); if (node.type === 'loop') walk(node.config.body.nodes, owner); } };
    walk(workflow.nodes, null);
    const contexts = new Map(this.contextNodes(workflow).map(item => [item.node.id, item.node]));
    for (const [contextId, list] of users) {
      const live = list.filter(item => planned.has(item.outerNode) && !reused.has(item.outerNode));
      const missing = list.filter(item => !planned.has(item.outerNode) || reused.has(item.outerNode));
      if (!live.length || !missing.length) continue;
      const context = contexts.get(contextId);
      const ok = context.config.mode === 'continue' && missing.every(item => reused.has(item.outerNode) && reused.get(item.outerNode).bindingId === context.config.bindingId);
      if (!ok) throw new ApiError(422, 'context_prerequisite', `Context "${contextId}" is shared by "${live[0].agent.id}" and "${missing[0].agent.id}", which is not part of this plan. A fresh conversation cannot stand in for its turns; run them together or use a Continue Context.`);
    }
    return { mode, targets: mode === 'workflow' ? viewers : targets, planned, reused, frozen, refreshCaches, pins: Object.fromEntries([...frozen].map(id => [id, pins[id]])) };
  }

  // Most recent succeeded attempt of `nodeId` whose captured fingerprint equals the current one.
  // The admitted definition being planned decides whether a task node may be reused; a later Draft cannot change that decision.
  reuseSource(workflow, workspaceId, nodeId, fingerprint) {
    if (allNodesDeep(workflow.nodes).some(node => node.id === nodeId && node.type === 'task')) return null;
    const runs = this.store.all(`SELECT * FROM runs WHERE workflow_id = ? AND workspace_id = ? AND kind = 'workflow' ORDER BY created_at DESC LIMIT 50`, workflow.workflowId, workspaceId);
    for (const run of runs) {
      const attempt = this.latestAttempt(run.id, nodeId);
      if (!attempt || !DONE_OK.has(attempt.state) || !attempt.outputs_artifact_id) continue;
      const captured = this.store.readJson(run.workflow_snapshot_artifact_id);
      const plan = run.plan_artifact_id ? this.store.readJson(run.plan_artifact_id) : { pins: {} };
      if (plan.effortPolicyVersion !== EFFORT_POLICY_VERSION) continue;
      if (fingerprints(captured, plan.pins || {})[nodeId] !== fingerprint) continue;
      return { runId: run.id, attemptId: attempt.id, outputs: attempt.outputs_artifact_id, bindingId: attempt.context_binding_id };
    }
    return null;
  }

  captureRun({ workflow, snapshot, workspace, kind, options, requestId, publication = null, p5Admission = null }) {
    const protectedSelfRepair = workflow.capabilities.includes('protected-self-repair-v1');
    if (protectedSelfRepair && !this.protectedSelfRepairEnrollment)
      throw new ApiError(409, 'p5_enrollment_unavailable', 'This runtime cannot start a P5 publication without a loaded installation-owned enrollment and protected admission path.');
    const parentAdmission = p5Admission?.kind === 'p5-parent-run-admission'
      && this.protectedSelfRepairRunAdmissions.has(p5Admission)
      && p5Admission.publication.publishedVersionId === publication?.id
      && p5Admission.enrollment.enrollmentId === this.protectedSelfRepairEnrollment?.enrollmentId;
    const repairAdmission = p5Admission?.kind === 'p5-repair-run-admission'
      && this.protectedSelfRepairRepairAdmissions.has(p5Admission)
      && p5Admission.enrollment.enrollmentId === this.protectedSelfRepairEnrollment?.enrollmentId
      && publication?.id === p5Admission.enrollment.repairPublication.publishedVersionId
      && p5Admission.parentRunId && p5Admission.attentionKey && p5Admission.judgeAttemptId;
    if (protectedSelfRepair && !parentAdmission && !repairAdmission)
      throw new ApiError(409, 'p5_admission_unavailable', 'P5 Run admission requires the exact enrolled Parent or Engine-issued P2 Repair admission.');
    if (!protectedSelfRepair && p5Admission)
      throw new ApiError(409, 'p5_admission_invalid', 'A P5 admission cannot authorize a non-P5 Run.');
    this.assertWorkflowJudgeRuntimeAvailable(workflow);
    if (publication) {
      const expectedAuthorityPolicyVersion = workflow.judgePolicy?.version || LEGACY_AUTHORITY_POLICY;
      if (publication.authority_policy_version !== expectedAuthorityPolicyVersion)
        throw new ApiError(409, 'conflict', 'Published authority policy metadata does not match its captured workflow definition.');
    }
    const active = this.activeRun(workspace.id);
    if (active) throw new ApiError(409, 'conflict', active.state === 'waiting_for_user' ? 'The previous run in this workspace is waiting for recovery; close or stop it first.' : 'Another run is active in this workspace.');
    if (this.protectedSelfRepairWorkspaceReserved?.(workspace.id))
      throw new ApiError(409, 'p5_workspace_reserved', 'An enrolled P5 workspace slot is single-use and remains reserved after its linked Repair is admitted.');
    // A Host-owned process may still be running in an overlapping workspace (H3): no other Run starts there until its owner confirms the end.
    if (this.custodyHoldOverlapping(workspace.cwd)) throw new ApiError(409, 'conflict', 'A Host-owned process may still be running in this workspace; another run cannot use it until its owner confirms that it has ended.');
    // A process that a restart could not confirm ended keeps the same workspace unavailable until that process ends.
    if (this.unconfirmedOverlapping(workspace.cwd)) throw new ApiError(409, 'conflict', 'A process that a restart could not confirm ended may still run in this workspace; another run cannot use it until it ends.');
    const validation = this.validateWorkflow(workflow);
    if (!validation.valid) throw new ApiError(422, 'validation_failed', 'The workflow is not executable.', validation.issues);
    const contexts = this.contextNodes(workflow);
    const continued = new Map();
    for (const { node } of contexts.filter(item => item.node.config.mode === 'continue')) {
      const binding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', node.config.bindingId);
      if (!binding || binding.workspace_id !== workspace.id || binding.provider !== node.config.provider || binding.state !== 'ready')
        throw new ApiError(422, 'context_unavailable', `Context "${node.id}" needs a ready ${node.config.provider} binding in this workspace (${binding ? `state is ${binding.state}` : 'binding not found'}).`);
      continued.set(node.id, binding);
    }
    if (workflow.settings.nativeConfiguration === 'inherit' && allNodesDeep(workflow.nodes).some(node => node.type === 'agent' && node.config.provider === 'antigravity'))
      throw new ApiError(422, 'unsupported_capability', 'Antigravity does not support inherited native configuration.');
    for (const node of allNodesDeep(workflow.nodes).filter(item => item.type === 'file-input' && item.config.mode === 'artifact')) {
      const row = this.store.artifactRow(node.config.artifact.artifactId);
      if (!row || row.sha256 !== node.config.artifact.sha256) throw new ApiError(422, 'validation_failed', `File input "${node.id}" pins an artifact that is not stored with that digest.`);
    }
    const plan = this.planRun(workflow, workspace, options.mode ? options : { mode: 'workflow', refreshCaches: [] });
    const settings = this.currentSettings();
    const runSettings = { schemaVersion: 1, applicationSettings: { revision: settings.revision, sha256: settings.sha256, settings: settings.settings },
      nativeConfiguration: workflow.settings.nativeConfiguration, maximumAgentTimeoutSeconds: this.maximumAgentTimeoutSeconds,
      processContainment: this.processContainment, workspace: this.workspaceBody(workspace) };
    assertValid(API, 'runSettings', runSettings);
    const { view, ...definition } = workflow;
    const runId = randomUUID();
    return this.store.transaction(() => {
      const settingsArtifact = this.store.putJson(runSettings);
      const planRecord = { schemaVersion: 1, effortPolicyVersion: EFFORT_POLICY_VERSION, mode: plan.mode, targets: plan.targets, planned: [...plan.planned], refreshCaches: plan.refreshCaches, frozen: [...plan.frozen], pins: plan.pins,
        reused: Object.fromEntries([...plan.reused].map(([id, source]) => [id, { runId: source.runId, attemptId: source.attemptId }])) };
      const planArtifact = this.store.putJson(planRecord);
      const createdAt = nowIso();
      this.store.run(`INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at, kind, plan_artifact_id, published_version_id, definition_digest)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
        runId, workflow.workflowId, workspace.id, snapshot.id, settingsArtifact.artifactId, canonicalHash(definition), createdAt, kind, planArtifact.artifactId,
        publication?.id ?? null, publication?.definition_digest ?? null);
      const events = [
        { type: 'run.created', payload: { workflowSnapshot: { artifactId: snapshot.id, sha256: snapshot.sha256 }, executionHash: canonicalHash(definition), settingsSnapshot: ref(settingsArtifact),
          ...(publication ? { publishedVersion: { publishedVersionId: publication.id, version: publication.version, definitionDigest: publication.definition_digest, authorityPolicyVersion: publication.authority_policy_version } } : {}) } },
        { type: 'run.state_changed', payload: { from: null, to: 'queued', reason: 'Run captured.' } },
        { type: 'run.planned', payload: { plan: ref(planArtifact), mode: plan.mode, targets: plan.targets } },
      ];
      if (parentAdmission) {
        const sourceBinding = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceBinding',
          enrollmentId: p5Admission.enrollment.enrollmentId, parentRunId: runId, parentPublication: p5Admission.publication,
          parentSnapshot: { artifactId: snapshot.id, sha256: snapshot.sha256 }, baselineId: p5Admission.enrollment.baselineId,
          baselineManifest: p5Admission.enrollment.baselineManifest, profile: p5Admission.profile,
          runningSourceRelease: p5Admission.runningSourceRelease, runtimeInstanceId: this.runtimeInstanceId,
          lifecycleGeneration: p5Admission.lifecycleGeneration, boundAt: createdAt };
        validateP5Contract('sourceBinding', sourceBinding);
        const sourceBindingArtifact = this.store.putJson(sourceBinding);
        this.store.verifyRef(sourceBindingArtifact);
        events.push({ type: 'self_repair.source_bound', payload: { record: ref(sourceBindingArtifact) } });
      }
      for (const { node } of contexts.filter(item => item.node.config.lifetime !== 'iteration')) {
        const bindingId = node.config.mode === 'continue' ? continued.get(node.id).id : this.createBinding(runId, workspace, node.config.provider, node.id, createdAt);
        this.store.run('INSERT INTO run_context_bindings(run_id, context_node_id, mode, binding_id) VALUES (?, ?, ?, ?)', runId, node.id, node.config.mode, bindingId);
      }
      const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
      const order = topologicalOrder(workflow).filter(id => id !== workflow.judgePolicy?.judgeNodeId && (plan.planned.has(id) || plan.reused.has(id)));
      for (const id of order) {
        this.store.run(`INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, ?, ?, ?, ?)`, runId, id, id, nodes.get(id).type, plan.reused.has(id) ? 'reused' : 'scheduled');
        events.push({ type: 'node.planned', nodeInstanceId: id, payload: { nodeId: id, nodeType: nodes.get(id).type, scope: null } });
      }
      for (const id of order) {
        const attemptId = randomUUID();
        const source = plan.reused.get(id);
        if (source) {
          this.store.run(`INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state, outputs_artifact_id, context_binding_id) VALUES (?, ?, ?, 1, 'reused', ?, ?)`, attemptId, runId, id, source.outputs, source.bindingId);
          events.push({ type: 'attempt.state_changed', nodeInstanceId: id, attemptId, payload: { from: null, to: 'reused', reason: `Reused from run ${source.runId}.`, process: null, ordinal: 1 } });
          events.push({ type: 'attempt.reused', nodeInstanceId: id, attemptId, payload: { sourceRunId: source.runId, sourceAttemptId: source.attemptId, outputs: { artifactId: source.outputs, sha256: this.store.artifactRow(source.outputs).sha256 } } });
        } else {
          this.store.run(`INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, ?, 1, 'scheduled')`, attemptId, runId, id);
          events.push({ type: 'attempt.state_changed', nodeInstanceId: id, attemptId, payload: { from: null, to: 'scheduled', reason: 'Planned before dispatch.', process: null, ordinal: 1 } });
        }
      }
      this.store.appendEvents(runId, events);
      return { status: 202, body: { outcome: 'created', run: this.runBody(this.store.get('SELECT * FROM runs WHERE id = ?', runId)), requestId } };
    });
  }

  // ---------- In-memory scopes ----------
  buildScope(graph, frozen, { loopInstance = null, iteration = null } = {}) {
    const prefix = loopInstance ? bodyPrefix(loopInstance, iteration) : '';
    const scope = { prefix, loopInstance, iteration, graph, nodes: new Map(graph.nodes.map(node => [node.id, node])), predecessors: new Map(), afterPredecessors: new Map() };
    for (const node of graph.nodes.filter(isExecutable)) { scope.predecessors.set(node.id, new Set()); scope.afterPredecessors.set(node.id, new Set()); }
    for (const edge of graph.edges) if (edge.source.nodeId !== INPUT && edge.target.nodeId !== RETURN && !frozen.has(edge.target.nodeId)) scope.predecessors.get(edge.target.nodeId)?.add(edge.source.nodeId);
    for (const pair of graph.after) scope.afterPredecessors.get(pair.after)?.add(pair.before);
    return scope;
  }

  // The in-memory scheduling state of one nonterminal run, rebuilt from its captured snapshot and plan.
  loadRunState(row) {
    const workflow = this.store.readJson(row.workflow_snapshot_artifact_id);
    const plan = row.plan_artifact_id ? this.store.readJson(row.plan_artifact_id) : { frozen: [], pins: {}, refreshCaches: [] };
    const state = { id: row.id, kind: row.kind, workflow, plan, frozen: new Set(plan.frozen), scopes: new Map(), loops: new Map() };
    state.scopes.set('', this.buildScope(workflow, state.frozen));
    return state;
  }

  startRun() {
    if (this.closing) return;
    for (const row of this.store.all(`SELECT * FROM runs WHERE state = 'queued' ORDER BY created_at`)) {
      if (!this.logicalRepairCanStart(row.id)) continue;
      if (this.runs.has(row.id)) continue;
      const state = this.loadRunState(row);
      this.runs.set(row.id, state);
      this.store.transaction(() => this.store.appendEvents(row.id, [this.runEvent(row, 'running', 'Scheduler started.')]));
    }
    this.pump();
  }

  scopeFor(state, prefix) {
    if (state.scopes.has(prefix)) return state.scopes.get(prefix);
    const parts = prefix.split('/').filter(Boolean);
    const loopInstance = parts.slice(0, -1).join('/');
    const iteration = Number(parts.at(-1));
    const loopNode = this.loopNode(state, loopInstance);
    const scope = this.buildScope(loopNode.config.body, state.frozen, { loopInstance, iteration });
    state.scopes.set(prefix, scope);
    return scope;
  }

  loopNode(state, loopInstance) {
    const { prefix, nodeId } = parseInstance(loopInstance);
    return this.scopeFor(state, prefix).nodes.get(nodeId);
  }

  locate(state, instanceId) {
    const { prefix, nodeId } = parseInstance(instanceId);
    const scope = this.scopeFor(state, prefix);
    return { scope, node: scope.nodes.get(nodeId) };
  }

  loopRuntime(state, loopInstance) {
    if (!state.loops.has(loopInstance)) state.loops.set(loopInstance, { node: this.loopNode(state, loopInstance), running: 0, since: 0, pending: null, timer: null });
    return state.loops.get(loopInstance);
  }

  // ---------- Journal helpers ----------
  runEvent(row, to, reason) {
    const from = this.store.get('SELECT state FROM runs WHERE id = ?', row.id).state;
    this.store.run('UPDATE runs SET state = ? WHERE id = ?', to, row.id);
    return { type: 'run.state_changed', payload: { from, to, reason } };
  }

  attemptTransition(attempt, to, reason, process = null, outcomeDetails = null) {
    const current = this.store.get('SELECT state FROM attempts WHERE id = ?', attempt.id);
    this.store.run('UPDATE attempts SET state = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?', to, TERMINAL_ATTEMPT.has(to) ? 1 : 0, nowIso(), attempt.id);
    this.store.run('UPDATE node_instances SET state = ? WHERE run_id = ? AND id = ?', to, attempt.run_id, attempt.node_instance_id);
    const events = [{ type: 'attempt.state_changed', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { from: current.state, to, reason, process } }];
    if (['failed', 'canceled', 'blocked', 'interrupted'].includes(to)) {
      const canceledBeforeLaunch = to === 'canceled' && UNSTARTED.has(attempt.state) && !attempt.process_id
        && !this.store.get('SELECT custody_id FROM attempt_custody WHERE attempt_id = ?', attempt.id);
      const defaults = to === 'canceled'
        ? { source: 'recovery', code: 'interrupted', causeKnowledge: 'direct_fact',
          executionCertainty: canceledBeforeLaunch ? 'not_started' : 'unknown', sideEffectCertainty: canceledBeforeLaunch ? 'none_proven' : 'unknown' }
        : to === 'interrupted' || to === 'blocked'
          ? { source: 'recovery', code: 'interrupted', causeKnowledge: 'unknown', executionCertainty: 'unresolved' }
          : { source: 'recovery', code: 'process', causeKnowledge: 'unknown', executionCertainty: 'unknown' };
      const outcome = this.failureOutcomeEvent(attempt, { ...defaults, ...outcomeDetails, attemptState: to });
      if (outcome) events.push(outcome);
    }
    return events;
  }

  failureOutcomeEvent(attempt = null, details = {}) {
    const attemptId = attempt?.id || details.attemptId || null;
    const currentAttempt = attemptId ? this.store.get('SELECT * FROM attempts WHERE id = ?', attemptId) : null;
    const runId = details.runId || currentAttempt?.run_id || attempt?.run_id;
    if (!runId) return null;
    if (!currentAttempt && !details.outcomeId) throw new TypeError('Run-scoped failure outcomes require a stable outcomeId.');
    const run = this.store.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.journal_version < 2) return null;
    const nodeInstanceId = currentAttempt?.node_instance_id || details.nodeInstanceId || null;
    const binding = currentAttempt ? this.store.get('SELECT custody_id FROM attempt_custody WHERE attempt_id = ?', currentAttempt.id) : null;
    const hold = binding ? this.store.get('SELECT evidence_json FROM custody_workspace_holds WHERE custody_id = ?', binding.custody_id) : null;
    const link = this.store.get(`SELECT incident_id,parent_run_id,repair_run_id FROM run_links
      WHERE parent_run_id = ? OR repair_run_id = ? ORDER BY created_at DESC LIMIT 1`, run.id, run.id);
    const artifact = details.evidence?.artifactId ? this.store.artifactRow(details.evidence.artifactId)
      : currentAttempt?.invocation_artifact_id ? this.store.artifactRow(currentAttempt.invocation_artifact_id) : null;
    const references = [
      ...(details.journalEventId ? [{ type: 'journal_event', id: details.journalEventId }] : []),
      ...(artifact ? [{ type: 'artifact', id: artifact.id, sha256: artifact.sha256 }] : []),
      ...(binding ? [{ type: 'custody_invocation', id: binding.custody_id }, { type: 'workspace_hold', id: binding.custody_id }] : []),
      ...(run.published_version_id ? [{ type: 'published_version', id: run.published_version_id }] : []),
      ...(link?.incident_id ? [{ type: 'p2_incident', id: link.incident_id }] : []),
    ];
    const observedState = { ...(details.observedState || {}) };
    if (hold?.evidence_json) {
      try {
        const evidence = parseStrictJson(hold.evidence_json);
        if (observedState.processTreeEnded === undefined && typeof evidence.processTreeEnded === 'boolean') observedState.processTreeEnded = evidence.processTreeEnded;
        if (observedState.hostState === undefined && typeof evidence.hostState === 'string') observedState.hostState = evidence.hostState;
        if (observedState.exitCode === undefined && Number.isInteger(evidence.exitCode)) observedState.exitCode = evidence.exitCode;
        if (observedState.spoolComplete === undefined && typeof evidence.spoolComplete === 'boolean') observedState.spoolComplete = evidence.spoolComplete;
      } catch { /* A malformed optional hold projection cannot erase the typed outcome. */ }
    }
    let executionCertainty = details.executionCertainty || 'unknown';
    if (executionCertainty === 'unknown' && observedState.processTreeEnded === true) executionCertainty = 'completed';
    if (executionCertainty === 'unknown' && currentAttempt && details.attemptState && UNSTARTED.has(currentAttempt.state) && !currentAttempt.process_id && !binding)
      executionCertainty = 'not_started';
    const source = details.source || sourceForErrorCode(details.code || 'process');
    const normalized = normalizeAttemptErrorCode(details.code || 'process', { source, operation: details.operation || 'execution' });
    const existing = details.outcomeId
      ? this.store.get('SELECT * FROM failure_outcomes WHERE outcome_id = ?', details.outcomeId)
      : currentAttempt ? this.store.get('SELECT * FROM failure_outcomes WHERE attempt_id = ?', currentAttempt.id) : null;
    const previous = existing ? parseStrictJson(existing.outcome_json) : null;
    const recordedAt = previous?.recordedAt || nowIso();
    const outcome = makeFailureOutcome({
      run: { ...run, custody_invocation_id: binding?.custody_id || null, incident_id: link?.incident_id || null,
        parent_run_id: link?.parent_run_id || null, repair_run_id: link?.repair_run_id || null },
      attempt: currentAttempt,
      outcomeId: previous?.outcomeId || details.outcomeId || currentAttempt?.id,
      source,
      code: normalized.canonicalCode,
      rawCode: details.rawCode ?? normalized.rawCode,
      attemptState: details.attemptState || currentAttempt?.state,
      runState: run.state,
      observedState,
      executionCertainty,
      sideEffectCertainty: details.sideEffectCertainty || (executionCertainty === 'not_started' ? 'none_proven' : 'unknown'),
      causeKnowledge: details.causeKnowledge || 'unknown',
      evidenceReferences: [...(previous?.evidenceReferences || []), ...references],
      recordedAt,
      updatedAt: previous ? nowIso() : undefined,
    });
    if (previous) {
      outcome.revision = previous.revision + 1;
      outcome.observedState = { ...previous.observedState, ...outcome.observedState };
      if (sameOutcome(previous, outcome)) return null;
    }
    return {
      type: currentAttempt
        ? previous ? 'attempt.failure_outcome_updated' : 'attempt.failure_outcome'
        : previous ? 'run.failure_outcome_updated' : 'run.failure_outcome',
      nodeInstanceId,
      attemptId: currentAttempt?.id ?? null,
      payload: { outcome },
    };
  }

  bindingTransition(binding, to, reason, changes = {}) {
    const from = binding.state;
    const updated = this.writeBinding(binding, { ...changes, state: to });
    return [{ type: 'context.state_changed', payload: { bindingId: binding.id, from, to, reason } }, updated];
  }

  planAttempt(state, instanceId, nodeId, nodeType, scope, events, reason = 'Planned before dispatch.') {
    const existing = this.store.get('SELECT MAX(ordinal) AS ordinal FROM attempts WHERE run_id = ? AND node_instance_id = ?', state.id, instanceId);
    if (!existing.ordinal) {
      this.store.run(`INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, ?, ?, ?, 'scheduled')`, state.id, instanceId, nodeId, nodeType);
      events.push({ type: 'node.planned', nodeInstanceId: instanceId, payload: { nodeId, nodeType, scope } });
    }
    const ordinal = (existing.ordinal || 0) + 1;
    const attemptId = randomUUID();
    this.store.run(`INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, ?, ?, 'scheduled')`, attemptId, state.id, instanceId, ordinal);
    this.store.run(`UPDATE node_instances SET state = 'scheduled' WHERE run_id = ? AND id = ?`, state.id, instanceId);
    events.push({ type: 'attempt.state_changed', nodeInstanceId: instanceId, attemptId, payload: { from: null, to: 'scheduled', reason, process: null, ordinal } });
    return attemptId;
  }

  // ---------- Scheduler ----------
  pump() {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (const state of [...this.runs.values()]) {
          try { this.pumpRun(state); }
          catch (error) { process.stderr.write(`Scheduler error in run ${state.id}: ${error.stack || error}\n`); }
        }
      } while (this.pumpAgain);
    } finally { this.pumping = false; }
  }

  runState(runId) { return this.store.get('SELECT state FROM runs WHERE id = ?', runId).state; }

  // A body scope is active only while every enclosing loop runs at that iteration with no pending pause.
  scopeActive(state, scope) {
    for (const { loopInstance, iteration } of enclosingLoops(scope.prefix)) {
      const loop = this.loopRow(state, loopInstance);
      if (loop?.state !== 'running' || loop.iteration !== iteration || state.loops.get(loopInstance)?.pending) return false;
    }
    return true;
  }

  // Status of one data input: active / inactive / pending / failed.
  inputStatus(state, scope, edge) {
    if (edge.source.nodeId === INPUT) return 'active';
    const source = this.latestAttempt(state.id, scope.prefix + edge.source.nodeId);
    if (!source) return 'inactive';
    if (source.state === 'skipped') return 'inactive';
    if (DONE_OK.has(source.state)) return this.store.readJson(source.outputs_artifact_id).values[edge.source.port] ? 'active' : 'inactive';
    if (['failed', 'canceled', 'interrupted', 'blocked'].includes(source.state)) return 'failed';
    return source.state === 'running' ? 'running' : 'pending';
  }

  readiness(state, attempt) {
    if (this.isManagedTaskStep(state, attempt.node_instance_id)) return this.managedTaskReadiness(state, attempt);
    if (this.isMapStep(state, attempt.node_instance_id)) return this.mapStepReadiness(state, attempt);
    if (!UNSTARTED.has(attempt.state) || this.processes.has(attempt.id)) return null;
    const located = this.locate(state, attempt.node_instance_id);
    if (!located?.node || !this.scopeActive(state, located.scope)) return null;
    const { scope, node } = located;
    if (node.type === 'loop' && this.loopRow(state, attempt.node_instance_id)) return null;
    if (node.type === 'map' && this.store.get('SELECT 1 FROM map_executions WHERE run_id = ? AND attempt_id = ?', state.id, attempt.id)) return null;
    if (node.type === 'task' && this.store.get('SELECT 1 FROM managed_tasks WHERE run_id=? AND attempt_id=?', state.id, attempt.id)) return null;
    for (const before of scope.afterPredecessors.get(node.id)) {
      const previous = this.latestAttempt(state.id, scope.prefix + before);
      if (previous && !['succeeded', 'reused', 'skipped'].includes(previous.state)) return null;
    }
    const edges = scope.graph.edges.filter(edge => edge.target.nodeId === node.id && !(state.frozen.has(node.id) && node.type === 'cache'));
    const statuses = edges.map(edge => ({ edge, status: this.inputStatus(state, scope, edge) }));
    if (node.type === 'merge' && node.config.mode === 'selected') {
      const outcome = selectedOutcome(statuses.map(item => item.status === 'active' ? 'succeeded' : item.status));
      if (outcome === 'wait' || outcome === 'recovery') return null;
      return { scope, node, action: outcome === 'commit' ? 'run' : outcome === 'inactive' ? 'skip' : 'conflict', chosen: statuses.find(item => item.status === 'active')?.edge };
    }
    if (statuses.some(item => item.status === 'inactive')) return { scope, node, action: 'skip' };
    if (!statuses.every(item => item.status === 'active')) return null;
    return { scope, node, action: 'run' };
  }

  pumpRun(state) {
    if (this.closing) return;
    const linkedRepairIssue = this.linkedRepairWorkspaceIssueForRun(state.id);
    if (linkedRepairIssue) {
      if (this.runState(state.id) === 'stopping') { this.finishRunIfDone(state); return; }
      if (!state.linkedRepairIsolationFailure) this.refuseLinkedRepairExecution(state, linkedRepairIssue);
      else this.finishRunIfDone(state);
      return;
    }
    const logicalParent = this.logicalRepairLinkForRun(state.id);
    if (logicalParent?.parent_run_id === state.id && logicalParent.parent_suspension_state !== 'resumed' && this.runState(state.id) !== 'stopping') {
      if (this.runState(state.id) === 'draining'
        && !this.store.get("SELECT id FROM attempts WHERE run_id = ? AND state IN ('running','draining')", state.id)) this.finishRunIfDone(state);
      if (logicalParent.state === 'repair_accepted') this.resumeLogicalRepairParent(logicalParent);
      else this.settleParentRepairSuspension(logicalParent.id);
      return;
    }
    // A missed controller acknowledgement pauses new dispatch only; work already running keeps its own timeouts.
    // Nothing launches for a supervised run until its observer is armed, and a paused controller stops new dispatch.
    // A controller pause must not prevent Root Stop from completing.
    if (this.awaitingArm.has(state.id) || (this.dispatchPaused.has(state.id) && this.runState(state.id) !== 'stopping')) return;
    if (this.judgeAttentionEnabled && this.runState(state.id) !== 'stopping' && this.hasJudgeBarrier(state.id)) return;
    const workflowJudgeMode = this.workflowJudgeDerivedMode(state);
    if (workflowJudgeMode === 'judge_only') { this.pumpWorkflowJudgeOnly(state); return; }
    if (workflowJudgeMode === 'held') { this.finishRunIfDone(state); return; }
    if (this.runState(state.id) === 'running') {
      for (const attempt of this.latestAttempts(state.id)) {
        const ready = this.readiness(state, attempt);
        if (!ready) continue;
        if (ready.action === 'skip') { this.skipAttempt(state, attempt, 'An input comes from an inactive Route output or a skipped node.'); this.pumpAgain = true; }
        else if (ready.action === 'conflict') this.failAttempt(state, attempt, 'output_contract', 'More than one alternative of a selected Merge is active.');
        else if (ready.action === 'map-step') { if (this.dispatchMapStep(state, attempt, ready.info)) this.pumpAgain = true; }
        else if (ready.action === 'task-step') this.dispatchManagedTaskStep(state, attempt, ready.info);
        else if (ready.node.type === 'task') { this.startManagedTask(state, ready.scope, ready.node, attempt); this.pumpAgain = true; }
        else if (ready.node.type === 'agent') this.tryDispatchAgent(state, ready.scope, ready.node, attempt);
        else if (ready.node.type === 'loop') { this.startLoop(state, ready.scope, ready.node, attempt); this.pumpAgain = true; }
        else if (ready.node.type === 'map') { this.startMap(state, ready.scope, ready.node, attempt); this.pumpAgain = true; }
        else if (ready.node.type === 'gate' && ready.node.config.mode === 'self-repair-verify') this.dispatchProtectedSelfRepairGate(state, ready.scope, ready.node, attempt);
        else { this.runStatic(state, ready.scope, ready.node, attempt, ready.chosen); this.pumpAgain = true; }
        if (this.runState(state.id) !== 'running') break;
      }
      if (this.runState(state.id) === 'running') for (const loop of this.store.all(`SELECT loop_node_id FROM loop_executions WHERE run_id = ? AND state = 'running'`, state.id)) this.maybeReturn(state, loop.loop_node_id);
      if (this.runState(state.id) === 'running' && this.advanceMaps(state)) this.pumpAgain = true;
      if (this.runState(state.id) === 'running' && this.advanceManagedTasks(state)) this.pumpAgain = true;
    }
    for (const loopInstance of state.loops.keys()) this.maybeSettlePause(state, loopInstance);
    if (this.runState(state.id) === 'draining') this.advanceManagedTasks(state);
    this.finishRunIfDone(state);
  }

  skipAttempt(state, attempt, reason) {
    this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(attempt, 'skipped', reason)));
  }

  liveIn(state) { return [...this.processes.values()].filter(record => record.runId === state.id); }

  finishRunIfDone(state) {
    // Another scheduler pass is pending (for example a Map just changed task states); decide after it.
    if (this.liveIn(state).length || this.pumpAgain) return;
    const settled = this.store.transaction(() => {
      let row = this.store.get('SELECT * FROM runs WHERE id = ?', state.id);
      if (!row || TERMINAL_RUN.has(row.state)) return null;
      // CP-01: finalization and P4 admission share this Store transaction. The eligibility read cannot race a terminal transition.
      if (this.workflowJudgeFinalizeInTransaction(state, row)) return { held: true, priorState: row.state };
      row = this.store.get('SELECT * FROM runs WHERE id = ?', state.id);
      let to = null, reason = '';
      if (row.state === 'stopping') { to = 'canceled'; reason = 'Root Stop completed after every child process exited.'; }
      else if (row.state === 'draining') {
        to = state.linkedRepairIsolationFailure || state.kind === 'chat' ? 'failed' : 'waiting_for_user';
        reason = state.linkedRepairIsolationFailure?.message || (state.kind === 'chat' ? 'The chat turn failed.' : 'Running attempts finished after a failure; recovery is needed.');
      } else if (row.state === 'running') {
        const latest = this.latestAttempts(state.id);
        const outer = latest.filter(attempt => !attempt.node_instance_id.includes('/'));
        if (outer.length && outer.every(attempt => ['succeeded', 'reused', 'skipped'].includes(attempt.state))) { to = 'succeeded'; reason = 'Every planned node succeeded, was reused, or was skipped by a Route.'; }
        else if (!latest.some(attempt => this.readiness(state, attempt))) {
          to = state.kind === 'chat' ? 'failed' : 'waiting_for_user';
          reason = 'No work can proceed; failed, stopped or paused work needs a decision.';
        }
      }
      if (!to) return null;
      // Crash point: every node is accepted and the Run's terminal state is not yet recorded.
      if (TERMINAL_RUN.has(to)) custodyFaultPoint('before_run_settle');
      // ADR-0008: a linked repair's outcome is recorded in the same transaction as its terminal state.
      this.store.appendEvents(state.id, [this.runEvent(row, to, reason)]);
      if (TERMINAL_RUN.has(to)) this.recordRepairOutcome(state.id, to);
      else if (to === 'waiting_for_user' && this.logicalRepairWaitingForDecision(state.id)) this.recordRepairOutcome(state.id, 'failed');
      return { to, priorState: row.state };
    });
    if (!settled || settled.held) return;
    const { to, priorState } = settled;
    if (priorState === 'stopping') this.recordTerminationProof(state.id).catch(error => process.stderr.write(`Termination proof for run ${state.id} failed: ${error.message}\n`));
    if (TERMINAL_RUN.has(to)) { this.endControl(state.id); this.forget(state); this.releaseHostRun(state.id, to); this.afterRepairRunTerminal(state.id, to); }
  }

  forget(state) {
    for (const loop of state.loops.values()) clearInterval(loop.timer);
    this.runs.delete(state.id);
  }

  // M2: the first failure stops dispatch but keeps unstarted work for recovery.
  latchFailure(state, events) {
    const row = this.store.get('SELECT * FROM runs WHERE id = ?', state.id);
    if (row.state === 'running') events.push(this.runEvent(row, 'draining', 'An attempt failed; no new dispatch until recovery.'));
  }

  failAttempt(state, attempt, code, message, { evidence = null, binding = null, bindingTo = null, bindingReason = '', bindingChanges = {},
    source = sourceForErrorCode(code), operation = 'execution', rawCode = null, executionCertainty = 'unknown', sideEffectCertainty,
    causeKnowledge, observedState = {} } = {}) {
    this.store.transaction(() => {
      const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
      if (!current || TERMINAL_ATTEMPT.has(current.state)) return;
      const normalized = normalizeAttemptErrorCode(code, { source, operation });
      const outcomeDetails = { source, code: normalized.canonicalCode, rawCode: rawCode ?? normalized.rawCode, executionCertainty,
        sideEffectCertainty, causeKnowledge: causeKnowledge || (code === normalized.canonicalCode ? 'deterministic_interpretation' : 'unknown'), observedState, evidence };
      const events = [{ type: 'attempt.error', nodeInstanceId: current.node_instance_id, attemptId: current.id,
        payload: { code: normalized.canonicalCode, message, evidence } }];
      events.push(...this.attemptTransition(current, 'failed', message, null, outcomeDetails));
      if (binding && bindingTo && binding.state !== bindingTo) events.push(this.bindingTransition(binding, bindingTo, bindingReason, bindingChanges)[0]);
      const { loopInstance } = parseInstance(current.node_instance_id);
      if (loopInstance) this.pauseLoop(state, loopInstance, 'body_failure', `Body node ${current.node_instance_id} failed: ${message}`, events);
      this.latchFailure(state, events);
      this.store.appendEvents(state.id, events);
    });
  }

  // Resolve a port value inside a scope: an edge from a node's latest output or a loop boundary.
  inputValue(state, scope, nodeId, port) {
    const edge = scope.graph.edges.find(item => item.target.nodeId === nodeId && item.target.port === port);
    if (!edge) throw new UtilityError('output_contract', `No edge supplies ${nodeId}.${port}.`);
    return this.edgeValue(state, scope, edge);
  }
  edgeValue(state, scope, edge) {
    if (edge.source.nodeId === INPUT) return this.boundaryValue(state, scope, edge.source.port);
    const source = this.latestAttempt(state.id, scope.prefix + edge.source.nodeId);
    if (!DONE_OK.has(source?.state) || !source.outputs_artifact_id) throw new UtilityError('output_contract', `${edge.source.nodeId} has no committed output.`);
    const value = this.store.readJson(source.outputs_artifact_id).values[edge.source.port];
    if (!value) throw new UtilityError('output_contract', `${edge.source.nodeId} did not commit port ${edge.source.port}.`);
    this.store.verifyRef(value.artifact);
    return value;
  }

  boundaryValue(state, scope, port) {
    const iteration = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, scope.loopInstance, scope.iteration);
    if (port === 'value') return parseStrictJson(iteration.value_json);
    if (port === 'feedback') return parseStrictJson(iteration.feedback_json);
    if (port === 'iteration') return jsonValue(this.store.putJson(scope.iteration));
    const loopAttempt = this.store.get('SELECT a.inputs_artifact_id FROM loop_executions l JOIN attempts a ON a.id = l.attempt_id WHERE l.run_id = ? AND l.loop_node_id = ?', state.id, scope.loopInstance);
    return this.store.readJson(loopAttempt.inputs_artifact_id).values[port];
  }

  commitOutputs(state, attempt, values, providerResult = null) {
    const manifest = { schemaVersion: 1, runId: state.id, attemptId: attempt.id, nodeId: parseInstance(attempt.node_instance_id).nodeId, values, providerResult };
    assertValid('attempt-record.schema.json', 'outputs', manifest, 'Output manifest');
    const artifact = this.store.putJson(manifest);
    this.store.run('UPDATE attempts SET outputs_artifact_id = ? WHERE id = ?', artifact.artifactId, attempt.id);
    return { type: 'attempt.outputs_committed', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { manifest: ref(artifact) } };
  }

  commitInputs(state, attempt, values, { prompt = null, promptSources = [], binding = null } = {}) {
    const manifest = { schemaVersion: 1, runId: state.id, attemptId: attempt.id, nodeId: parseInstance(attempt.node_instance_id).nodeId, values,
      contextBindingId: binding?.id ?? null, prompt, promptSources, contextBinding: binding ? { artifactId: binding.binding_artifact_id, sha256: this.store.artifactRow(binding.binding_artifact_id).sha256 } : null };
    assertValid('attempt-record.schema.json', 'inputs', manifest, 'Input manifest');
    const artifact = this.store.putJson(manifest);
    this.store.run('UPDATE attempts SET inputs_artifact_id = ?, context_binding_id = ? WHERE id = ?', artifact.artifactId, binding?.id ?? null, attempt.id);
    return { type: 'attempt.inputs_committed', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { manifest: ref(artifact), prompt, contextBindingId: binding?.id ?? null } };
  }

  workspaceOf(state) { return this.store.get('SELECT w.* FROM workspaces w JOIN runs r ON r.workspace_id = w.id WHERE r.id = ?', state.id); }

  runStatic(state, scope, node, attempt, chosen) {
    try {
      this.store.transaction(() => {
        const values = {};
        const events = [];
        const frozen = node.type === 'cache' && state.frozen.has(node.id);
        if (node.type === 'merge' && node.config.mode === 'selected') values[chosen.target.port] = this.edgeValue(state, scope, chosen);
        else if (!frozen) for (const port of Object.keys(nodePorts(node).inputs)) values[port] = this.inputValue(state, scope, node.id, port);
        let outputs = {};
        if (node.type === 'text') outputs = { text: textValue(this.store.putText(node.config.value)) };
        else if (node.type === 'prompt-template') {
          const texts = Object.fromEntries(node.config.slots.map(slot => [slot.id, this.store.readText(values[slot.id].artifact.artifactId)]));
          outputs = { text: textValue(this.store.putText(node.config.template.replace(/\{\{([a-z][a-z0-9-]{0,63})\}\}/g, (_, id) => texts[id]))) };
        } else if (node.type === 'merge' && node.config.mode === 'selected') outputs = { value: values[chosen.target.port] };
        else if (node.type === 'cache') {
          if (frozen) {
            const pin = state.plan.pins[node.id];
            this.store.verifyRef(pin.value.artifact);
            outputs = { value: pin.value };
            events.push({ type: 'cache.reused', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { nodeId: node.id, pin: pin.value, sourceRunId: pin.sourceRunId, sourceAttemptId: pin.sourceAttemptId } });
          } else {
            if (values.value.type !== node.config.valueType) throw new UtilityError('output_contract', `Cache expects ${node.config.valueType}, got ${values.value.type}.`);
            outputs = { value: values.value };
            if (state.plan.refreshCaches.includes(node.id)) {
              this.storePin(state.workflow, node.id, values.value, state.id, attempt.id);
              events.push({ type: 'cache.pinned', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { nodeId: node.id, pin: values.value, sourceRunId: state.id, sourceAttemptId: attempt.id } });
            }
          }
        } else if (node.type === 'route') {
          const selected = this.store.readJson(values.selector.artifact.artifactId);
          const found = resolvePointer(selected, node.config.selector);
          if (!found.found) throw new UtilityError('output_contract', `Route selector ${node.config.selector} does not exist.`);
          const match = routeCase(node.config.cases, found.value);
          if (match.error) throw new UtilityError('output_contract', `More than one Route case matches ${JSON.stringify(found.value)}.`);
          events.push({ type: 'route.selected', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { caseId: match.caseId, selector: values.selector } });
          if (!match.caseId) throw new UtilityError('route_unmatched', `No Route case matches ${JSON.stringify(found.value)}${node.config.onUnmatched === 'pause' ? '; the run waits for your decision' : ''}.`);
          outputs = { [match.caseId]: values.value };
        } else if (node.type === 'gate') outputs = this.runGate(state, scope, node, attempt, values, events);
        else if (node.type !== 'result-viewer') outputs = runUtility({ store: this.store, node, inputs: values, cwd: this.workspaceOf(state).cwd });
        const committed = [this.commitInputs(state, attempt, values)];
        committed.push(...this.attemptTransition(attempt, 'running', 'Static node started.'));
        committed.push(...events);
        committed.push(this.commitOutputs(state, attempt, outputs));
        committed.push(...this.attemptTransition(attempt, 'succeeded', 'Static node committed its outputs.'));
        this.store.appendEvents(state.id, committed);
      });
    } catch (error) {
      const code = error instanceof CorruptionError ? 'corruption' : error instanceof UtilityError ? error.code : 'output_contract';
      if (code === 'route_unmatched') {
        // The route.selected observation is part of the evidence even though the attempt fails.
        this.store.transaction(() => this.store.appendEvents(state.id, [{ type: 'route.selected', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { caseId: null, selector: this.inputValue(state, scope, node.id, 'selector') } }]));
      }
      this.failAttempt(state, attempt, code, error.message);
    }
  }

  // ---------- Gate ----------
  putRecord(state, kind, record) {
    const artifact = this.store.putJson(record);
    this.store.run('INSERT OR IGNORE INTO pipeline_records(id, run_id, kind, artifact_id, created_at) VALUES (?, ?, ?, ?, ?)', record.recordId, state.id, kind, artifact.artifactId, nowIso());
    const row = this.store.get('SELECT * FROM pipeline_records WHERE id = ?', record.recordId);
    return { recordId: record.recordId, artifact: { artifactId: row.artifact_id, sha256: this.store.artifactRow(row.artifact_id).sha256 } };
  }

  recordLookup() {
    return id => {
      const row = this.store.get('SELECT * FROM pipeline_records WHERE id = ?', id);
      if (!row) return null;
      return { kind: row.kind, ref: { recordId: id, artifact: { artifactId: row.artifact_id, sha256: this.store.artifactRow(row.artifact_id).sha256 } }, value: this.store.readJson(row.artifact_id) };
    };
  }

  // The Agent that reviews a slot: wired directly or as one alternative of a selected Merge.
  slotReviewer(scope, evaluateNode, slotId) {
    const edge = scope.graph.edges.find(item => item.target.nodeId === evaluateNode.id && item.target.port === slotId);
    if (!edge) return null;
    const source = scope.nodes.get(edge.source.nodeId);
    if (source?.type === 'agent') return { agent: source, merge: null };
    if (source?.type === 'merge' && source.config.mode === 'selected') {
      const alternatives = scope.graph.edges.filter(item => item.target.nodeId === source.id).map(item => ({ edge: item, node: scope.nodes.get(item.source.nodeId) }));
      const agent = alternatives.find(item => item.node?.type === 'agent' && item.edge.source.port === 'json');
      return agent ? { agent: agent.node, merge: source, alternatives } : null;
    }
    return null;
  }

  // Reviewer fingerprint: a Merkle hash of every definition upstream of the reviewing Agent's inputs
  // and After prerequisites (instructions through any template slot, selectors, the Agent and its
  // Context policy), stopping at the prepare Gate whose subject-derived values the scope hash covers,
  // plus the native profile. Inputs whose content cannot be established from definitions fail closed
  // (null → live review): other Agents, Loops, Maps or Gates, workspace files, Loop boundary values, a
  // Continue Context, and any Context another node also writes (its native history is unprovable).
  reviewerFingerprint(state, scope, agent, prepareId) {
    let unknown = false;
    const memo = new Map();
    const visit = id => {
      if (id === prepareId) return 'subject';
      if (id === INPUT) { unknown = true; return null; }
      if (memo.has(id)) return memo.get(id);
      memo.set(id, null);
      const node = scope.nodes.get(id);
      if (!node || (id !== agent.id && ['agent', 'loop', 'map', 'gate', 'task'].includes(node.type)) || (node.type === 'file-input' && node.config.mode === 'files')) unknown = true;
      let context = null;
      if (node?.type === 'agent' && node.config.contextId) {
        context = scope.nodes.get(node.config.contextId) || this.contextNodes(state.workflow).find(item => item.node.id === node.config.contextId)?.node;
        if (!context || context.config.mode === 'continue') unknown = true;
        const writers = allNodesDeep(state.workflow.nodes).filter(other => other.id !== node.id && contextIdsOf(other).includes(node.config.contextId));
        if (writers.length) unknown = true;
      }
      const inputs = scope.graph.edges.filter(edge => edge.target.nodeId === id).map(edge => [edge.target.port, edge.source.port, visit(edge.source.nodeId)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const after = scope.graph.after.filter(pair => pair.after === id).map(pair => visit(pair.before)).sort();
      const value = canonicalHash({ type: node?.type ?? null, config: node?.config ?? null, context: context?.config ?? null, inputs, after });
      memo.set(id, value);
      return value;
    };
    const closure = visit(agent.id);
    return unknown ? null : canonicalHash({ version: 4, closure, nativeConfiguration: state.workflow.settings.nativeConfiguration });
  }

  runGate(state, scope, node, attempt, values, events) {
    const config = node.config;
    if (config.mode === 'self-repair-verify')
      throw new UtilityError('p5_verification_unavailable', 'Protected Self-Repair verification is fail-closed: this Engine has no installed enrollment, trusted verifier, or Host-backed Gate recovery binding.');
    if (config.mode === 'prepare') {
      const evaluator = scope.graph.edges.filter(item => item.source.nodeId === node.id && item.source.port === 'plan').map(item => scope.nodes.get(item.target.nodeId))
        .find(item => item?.type === 'gate' && item.config.mode === 'evaluate');
      const reviewerFingerprints = {};
      if (evaluator) for (const slot of config.policy.slots) {
        const found = this.slotReviewer(scope, evaluator, slot.id);
        if (found) reviewerFingerprints[slot.id] = this.reviewerFingerprint(state, scope, found.agent, node.id);
      }
      const result = config.subject === 'delivery'
        ? gate.prepareDelivery({ store: this.store, config, inputs: values, readRecord: this.recordLookup() })
        : gate.prepare({ store: this.store, config, inputs: values, reviewerFingerprints, readRecord: this.recordLookup() });
      events.push({ type: 'gate.evaluated', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: result.event });
      return result.outputs;
    }
    if (config.mode === 'evaluate') {
      const reviewers = {};
      for (const slot of config.policy.slots) {
        const found = this.slotReviewer(scope, node, slot.id);
        const source = found ? this.latestAttempt(state.id, scope.prefix + found.agent.id) : null;
        // Only a live Agent answer that actually reached this slot names a reviewer.
        if (!source || !DONE_OK.has(source.state) || !source.outputs_artifact_id) continue;
        const outputs = this.store.readJson(source.outputs_artifact_id);
        reviewers[slot.id] = { nodeInstanceId: source.node_instance_id, attemptId: source.id, requestedModel: outputs.providerResult?.requestedModel || 'unknown', observedModel: outputs.providerResult?.observedModel ?? null };
      }
      const now = nowIso();
      const result = gate.evaluate({ store: this.store, config, inputs: values, reviewers, runId: state.id, now, readRecord: this.recordLookup() });
      const reviewRefs = result.records.map(record => this.putRecord(state, record.kind, record));
      for (const record of result.records.filter(item => item.kind === 'ReviewCarry'))
        events.push({ type: 'gate.review_carried', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { slot: record.slot, subjectId: record.subjectId, priorSubjectId: record.priorSubjectId,
          record: reviewRefs.find(item => item.recordId === record.recordId), priorReview: record.priorReview } });
      let certificate = null;
      if (result.status === 'OPEN') certificate = this.putRecord(state, 'GateCertificate', gate.certificateFor({ plan: result.plan, reviewRefs, runId: state.id, now }));
      const report = gate.report({ status: result.status, subjectId: result.plan.subjectId, reason: result.reason, issues: result.issues, certificate });
      events.push({ type: 'gate.evaluated', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mode: 'evaluate', subjectId: result.plan.subjectId, status: result.status, recordId: certificate?.recordId ?? null } });
      return { report: jsonValue(this.store.putJson(report)), certificate: jsonValue(this.store.putJson(certificate)) };
    }
    const result = gate.verify({ store: this.store, config, inputs: values, lookupRecord: id => this.store.get('SELECT * FROM pipeline_records WHERE id = ?', id) });
    const report = gate.report({ status: result.status, subjectId: result.subjectId, reason: result.reason, issues: [], certificate: result.certificate });
    events.push({ type: 'gate.evaluated', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mode: 'verify', subjectId: result.subjectId, status: result.status, recordId: result.certificate?.recordId ?? null } });
    return { report: jsonValue(this.store.putJson(report)) };
  }

  // ---------- Loops ----------
  loopRow(state, loopInstance) { return this.store.get('SELECT * FROM loop_executions WHERE run_id = ? AND loop_node_id = ?', state.id, loopInstance); }

  activeMs(runId, loopInstance, row) {
    const runtime = this.runs.get(runId)?.loops.get(loopInstance);
    const base = row?.active_ms ?? 0;
    return Math.round(runtime && runtime.running > 0 ? base + (performance.now() - runtime.since) : base);
  }

  validCarry(loop, value) {
    if (value.type !== loop.config.valueType) return `expected ${loop.config.valueType}, got ${value.type}`;
    if (value.type === 'JsonValue') {
      const issues = compileOutputSchema(loop.config.stateSchema)(this.store.readJson(value.artifact.artifactId));
      if (issues.length) return `state does not match stateSchema: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`;
    }
    if (value.type === 'ArtifactSet') this.values.readManifest(value.artifact);
    return null;
  }

  startLoop(state, scope, loop, attempt) {
    const loopInstance = attempt.node_instance_id;
    let values;
    try {
      values = {};
      for (const port of Object.keys(nodePorts(loop).inputs)) values[port] = this.inputValue(state, scope, loop.id, port);
      const invalid = this.validCarry(loop, values.seed);
      if (invalid) throw new UtilityError('output_contract', `Loop seed is invalid: ${invalid}.`);
    } catch (error) {
      return this.failAttempt(state, attempt, error.code === 'corruption' ? 'corruption' : 'output_contract', error.message);
    }
    this.store.transaction(() => {
      const events = [this.commitInputs(state, attempt, values)];
      events.push(...this.attemptTransition(attempt, 'running', 'Loop started.'));
      const { maxIterations, maxActiveMinutes } = loop.config.limits;
      this.store.run(`INSERT INTO loop_executions(run_id, loop_node_id, attempt_id, state, iteration, max_iterations, max_active_minutes, active_ms, pause_reason) VALUES (?, ?, ?, 'running', 1, ?, ?, 0, NULL)`,
        state.id, loopInstance, attempt.id, maxIterations, maxActiveMinutes);
      this.loopRuntime(state, loopInstance);
      events.push({ type: 'loop.started', nodeInstanceId: loopInstance, attemptId: attempt.id, payload: { loopNodeId: loopInstance, maxIterations, maxActiveMinutes, seed: values.seed } });
      this.startIteration(state, loopInstance, attempt, 1, values.seed, textValue(this.store.putText('')), events, false);
      this.store.appendEvents(state.id, events);
    });
  }

  startIteration(state, loopInstance, loopAttempt, iteration, value, feedback, events, restart) {
    const now = nowIso();
    const loop = this.loopNode(state, loopInstance);
    if (restart) this.store.run(`UPDATE loop_iterations SET outcome = 'running', started_at = ?, ended_at = NULL, candidate_json = NULL, decision_json = NULL WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`, now, state.id, loopInstance, iteration);
    else this.store.run(`INSERT INTO loop_iterations(run_id, loop_node_id, iteration, value_json, feedback_json, candidate_json, decision_json, outcome, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'running', ?, NULL)`,
      state.id, loopInstance, iteration, canonicalize(value), canonicalize(feedback), now);
    this.store.run(`UPDATE loop_executions SET iteration = ? WHERE run_id = ? AND loop_node_id = ?`, iteration, state.id, loopInstance);
    const body = loop.config.body;
    const scope = this.scopeFor(state, bodyPrefix(loopInstance, iteration));
    const workspace = this.workspaceOf(state);
    for (const context of body.nodes.filter(node => node.type === 'context' && node.config.lifetime === 'iteration')) {
      const key = scope.prefix + context.id;
      if (!this.store.get('SELECT 1 FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, key))
        this.store.run('INSERT INTO run_context_bindings(run_id, context_node_id, mode, binding_id) VALUES (?, ?, ?, ?)', state.id, key, 'new', this.createBinding(state.id, workspace, context.config.provider, key));
    }
    events.push({ type: 'loop.iteration_started', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration, value, feedback, restart } });
    const nodes = new Map(body.nodes.map(node => [node.id, node]));
    const required = requiredSet(body, returnSources(body), state.frozen);
    for (const id of topologicalOrder(body).filter(item => required.has(item))) {
      if (restart) {
        const latest = this.latestAttempt(state.id, scope.prefix + id);
        if (latest && UNSTARTED.has(latest.state)) events.push(...this.attemptTransition(latest, 'canceled', 'Superseded by an iteration restart.', null,
          { source: 'workflow', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'not_started', sideEffectCertainty: 'none_proven' }));
      }
      this.planAttempt(state, scope.prefix + id, id, nodes.get(id).type, { loopNodeId: loopInstance, iteration }, events, restart ? 'Iteration restarted.' : 'Planned for this iteration.');
    }
  }

  returnValue(state, scope, port) {
    const edge = scope.graph.edges.find(item => item.target.nodeId === RETURN && item.target.port === port);
    if (edge.source.nodeId === INPUT) return { value: this.boundaryValue(state, scope, edge.source.port) };
    const status = this.inputStatus(state, scope, edge);
    if (status === 'inactive') return { inactive: true };
    if (status !== 'active') return null;
    return { value: this.edgeValue(state, scope, edge) };
  }

  maybeReturn(state, loopInstance) {
    const row = this.loopRow(state, loopInstance);
    if (row?.state !== 'running' || state.loops.get(loopInstance)?.pending) return;
    const scope = this.scopeFor(state, bodyPrefix(loopInstance, row.iteration));
    if (!this.scopeActive(state, scope)) return;
    const iteration = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, loopInstance, row.iteration);
    if (iteration?.outcome !== 'running') return;
    const loop = this.loopNode(state, loopInstance);
    const candidateResult = this.returnValue(state, scope, 'candidate');
    const decisionResult = this.returnValue(state, scope, 'decision');
    if (!candidateResult || !decisionResult) return;
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', row.attempt_id);
    let problem = candidateResult.inactive || decisionResult.inactive ? 'a Loop Return source is inactive (skipped by a Route); join alternatives with a selected Merge' : null;
    const candidate = candidateResult.value, decisionValue = decisionResult.value;
    let decision;
    if (!problem) problem = this.validCarry(loop, candidate);
    if (!problem) {
      if (decisionValue.type !== 'JsonValue') problem = 'the decision must be JsonValue';
      else {
        decision = this.store.readJson(decisionValue.artifact.artifactId);
        const issues = check('loop-decision.schema.json', null, decision);
        if (issues.length) problem = `the decision violates the loop-decision contract (${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')})`;
      }
    }
    this.store.transaction(() => {
      const events = [];
      if (problem) {
        events.push({ type: 'attempt.error', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { code: 'output_contract', message: `Iteration ${row.iteration} returned an invalid value: ${problem}.`, evidence: null } });
        const outcome = this.failureOutcomeEvent(loopAttempt, { source: 'workflow', code: 'output_contract', causeKnowledge: 'direct_fact',
          attemptState: loopAttempt.state, executionCertainty: 'completed' });
        if (outcome) events.push(outcome);
        this.pauseLoop(state, loopInstance, 'body_failure', `Invalid loop return: ${problem}.`, events);
        this.latchFailure(state, events);
        this.store.appendEvents(state.id, events);
        return;
      }
      events.push({ type: 'loop.iteration_returned', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration: row.iteration, candidate, decision: decisionValue, continue: decision.continue, reason: decision.reason } });
      this.store.run(`UPDATE loop_iterations SET candidate_json = ?, decision_json = ?, outcome = ?, ended_at = ? WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`,
        canonicalize(candidate), canonicalize(decisionValue), decision.continue ? 'continued' : 'finished', nowIso(), state.id, loopInstance, row.iteration);
      const step = loopStep({ iteration: row.iteration, maxIterations: row.max_iterations, continue: decision.continue });
      if (step === 'finish') {
        const activeMs = this.closeActiveSegment(state, loopInstance);
        this.store.run(`UPDATE loop_executions SET state = 'finished', active_ms = ? WHERE run_id = ? AND loop_node_id = ?`, activeMs, state.id, loopInstance);
        events.push({ type: 'loop.finished', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iterations: row.iteration, result: candidate, activeMs } });
        events.push(this.commitOutputs(state, loopAttempt, { result: candidate, decision: decisionValue }));
        events.push(...this.attemptTransition(loopAttempt, 'succeeded', `Checker finished the loop after ${row.iteration} iteration(s).`));
      } else if (step === 'pause_iteration_limit') {
        this.store.run(`UPDATE loop_iterations SET outcome = 'paused' WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`, state.id, loopInstance, row.iteration);
        this.pauseLoop(state, loopInstance, 'iteration_limit', `The checker asked to continue after the last permitted iteration (${row.max_iterations}).`, events);
      } else {
        this.startIteration(state, loopInstance, loopAttempt, row.iteration + 1, candidate, textValue(this.store.putText(decision.feedback)), events, false);
      }
      this.store.appendEvents(state.id, events);
    });
    this.pumpAgain = true;
  }

  pauseLoop(state, loopInstance, reason, message, events) {
    const row = this.loopRow(state, loopInstance);
    if (!row || row.state !== 'running') return;
    const activeMs = this.closeActiveSegment(state, loopInstance);
    this.store.run(`UPDATE loop_executions SET state = 'paused', pause_reason = ?, active_ms = ? WHERE run_id = ? AND loop_node_id = ?`, reason, activeMs, state.id, loopInstance);
    this.store.run(`UPDATE loop_iterations SET outcome = 'paused' WHERE run_id = ? AND loop_node_id = ? AND iteration = ? AND outcome = 'running'`, state.id, loopInstance, row.iteration);
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', row.attempt_id);
    events.push({ type: 'loop.paused', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration: row.iteration, reason, message, activeMs } });
    events.push(...this.attemptTransition(loopAttempt, 'waiting', `Loop paused: ${reason}.`));
    const runtime = state.loops.get(loopInstance);
    if (runtime) runtime.pending = null;
  }

  resumeLoop(state, loopInstance, reason, events) {
    const row = this.loopRow(state, loopInstance);
    this.store.run(`UPDATE loop_executions SET state = 'running', pause_reason = NULL WHERE run_id = ? AND loop_node_id = ?`, state.id, loopInstance);
    this.store.run(`UPDATE loop_iterations SET outcome = 'running' WHERE run_id = ? AND loop_node_id = ? AND iteration = ? AND outcome = 'paused'`, state.id, loopInstance, row.iteration);
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', row.attempt_id);
    events.push({ type: 'loop.resumed', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration: row.iteration, reason } });
    events.push(...this.attemptTransition(loopAttempt, 'running', `Loop resumed: ${reason}`));
  }

  // Pending pauses (time limit, scoped Stop) settle once the loop's body processes have exited.
  maybeSettlePause(state, loopInstance) {
    const runtime = state.loops.get(loopInstance);
    if (!runtime?.pending || runtime.running > 0) return;
    if (this.liveIn(state).some(record => record.loops.includes(loopInstance))) return;
    const [reason, message] = runtime.pending;
    this.store.transaction(() => { const events = []; this.pauseLoop(state, loopInstance, reason, message, events); this.store.appendEvents(state.id, events); });
    runtime.pending = null;
  }

  // Active time is the union of intervals with at least one running body process, per enclosing loop.
  bodyStarted(state, loopInstance) {
    const runtime = this.loopRuntime(state, loopInstance);
    if (runtime.running++ === 0) {
      runtime.since = performance.now();
      clearInterval(runtime.timer);
      runtime.timer = setInterval(() => this.checkTimeLimit(state, loopInstance), 200);
    }
  }
  bodyEnded(state, loopInstance) {
    const runtime = this.loopRuntime(state, loopInstance);
    if (--runtime.running === 0) {
      clearInterval(runtime.timer); runtime.timer = null;
      const row = this.loopRow(state, loopInstance);
      if (row) this.store.run('UPDATE loop_executions SET active_ms = ? WHERE run_id = ? AND loop_node_id = ?', Math.round(row.active_ms + performance.now() - runtime.since), state.id, loopInstance);
    }
  }
  closeActiveSegment(state, loopInstance) {
    const row = this.loopRow(state, loopInstance);
    const runtime = state.loops.get(loopInstance);
    if (!runtime || runtime.running === 0) return row.active_ms;
    const total = Math.round(row.active_ms + performance.now() - runtime.since);
    runtime.since = performance.now();
    this.store.run('UPDATE loop_executions SET active_ms = ? WHERE run_id = ? AND loop_node_id = ?', total, state.id, loopInstance);
    return total;
  }
  checkTimeLimit(state, loopInstance) {
    const row = this.loopRow(state, loopInstance);
    const runtime = state.loops.get(loopInstance);
    if (!row || row.state !== 'running' || runtime.pending) return;
    if (this.activeMs(state.id, loopInstance, row) <= row.max_active_minutes * this.loopMinuteMs) return;
    runtime.pending = ['time_limit', `Active time exceeded ${row.max_active_minutes} minute(s).`];
    this.stopLoopBody(state, loopInstance);
  }
  stopLoopBody(state, loopInstance, source = 'workflow') {
    this.store.transaction(() => {
      const taskEvents = [];
      for (const execution of this.taskState(state).executions.values()) if (execution.row.node_instance_id.startsWith(`${loopInstance}/`))
        this.cancelManagedTasks(state.id, taskEvents, 'Managed task canceled when its enclosing loop stopped.', execution.row.node_instance_id, source);
      if (taskEvents.length) this.store.appendEvents(state.id, taskEvents);
    });
    for (const record of this.liveIn(state).filter(item => item.loops.includes(loopInstance))) {
      record.stopRequested = true;
      record.stopSource = source;
      record.stopReason = source === 'external_control' ? 'Stopped by the user through scoped Stop.' : 'Stopped by its enclosing loop execution policy.';
      record.abortController?.abort();
      if (record.launched) this.terminateLaunched(record.child);
    }
    queueMicrotask(() => this.pump());
  }

  // ---------- Agents ----------
  capacityAvailable(provider, settings) {
    const live = [...this.processes.values()].filter(record => record.provider);
    return live.length < settings.globalLimit && live.filter(item => item.provider === provider).length < settings.providerLimits[provider];
  }

  contextKey(state, scope, contextId) {
    const context = this.contextNodes(state.workflow).find(item => item.node.id === contextId)?.node;
    if (context?.config.lifetime !== 'iteration') return contextId;
    // The iteration of the loop that owns the Context: the innermost enclosing body that declares it.
    for (const { loopInstance, iteration } of enclosingLoops(scope.prefix)) {
      if (this.loopNode(state, loopInstance).config.body.nodes.some(node => node.id === contextId)) return bodyPrefix(loopInstance, iteration) + contextId;
    }
    return contextId;
  }

  // `spec` (Map steps) supplies the directory, Context mapping, prompt and answer hooks.
  tryDispatchAgent(state, scope, node, attempt, spec = null) {
    if (state.workflow.judgePolicy?.judgeNodeId === node.id) {
      const attention = this.workflowJudgeCurrentAttention(state.id);
      if (!attention || attention.judgeAttemptId !== attempt.id || spec && !spec.workflowJudge) return;
      node = this.workflowJudgeExecutionNode(state, node);
      spec ||= this.workflowJudgeSpec(state, node, attempt, attention);
    }
    const workspace = spec?.workspace || this.workspaceOf(state);
    const mapping = spec ? spec.mapping : node.config.contextId ? this.store.get('SELECT * FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, this.contextKey(state, scope, node.config.contextId)) : null;
    const keys = [`cwd:${workspace.cwd_identity}`, ...(mapping ? [`binding:${mapping.binding_id}`] : [])].sort();
    const settings = this.currentSettings().settings;
    // A durable Process Custody hold on an overlapping physical root blocks dispatch even when no in-memory lock remains (H3).
    const heldBy = this.custodyHoldOverlapping(workspace.cwd);
    // A Host-owned CLI is not started where an active managed-task delivery writes into the repository (only Custody-scoped attempts wait).
    const custodied = this.custodyScopeAllows(node, { mapped: Boolean(spec), taskExecutionId: spec?.taskExecutionId, loops: enclosingLoops(scope.prefix) });
    // Custody also waits for a managed-task delivery and for a process that a restart could not confirm ended (both are in custodyDeliveryOverlapping).
    const unconfirmed = custodied && this.unconfirmedOverlapping(workspace.cwd);
    const delivering = custodied && this.custodyDeliveryOverlapping(workspace.cwd);
    // Another Custody claim on an overlapping root (a different workspace id, or a nested or aliased directory) holds it until its own claim is released.
    const launching = custodied && this.custodyLaunchOverlapping(workspace.cwd);
    if (keys.some(key => this.locks.has(key)) || heldBy || delivering || launching || !this.capacityAvailable(node.config.provider, settings)) {
      if (attempt.state === 'scheduled') this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(attempt, 'waiting', heldBy
        ? 'Waiting for a Host-owned process to end in this workspace; its owner has not yet confirmed that it has.'
        : unconfirmed ? 'Waiting for a process that a restart could not confirm ended in this workspace.'
        : delivering ? 'Waiting for a managed-task delivery into this repository to end.'
        : launching ? 'Waiting for another Host-owned process in an overlapping workspace to end.'
        : 'Waiting for provider capacity or a directory/Context lock.')));
      return;
    }
    for (const key of keys) { this.locks.add(key); this.store.run('INSERT INTO resource_locks(resource_key, run_id, attempt_id, acquired_at) VALUES (?, ?, ?, ?)', key, state.id, attempt.id, nowIso()); }
    // custodyCwd: from this dispatch until its durable hold is written (after the Host admits it), this record is what tells a managed-task
    // delivery that a Host-owned CLI is about to run here. It is set in the same synchronous step as the checks above.
    const record = { runId: state.id, taskExecutionId: spec?.taskExecutionId, loops: enclosingLoops(scope.prefix).map(item => item.loopInstance), provider: node.config.provider, keys, child: null, stopRequested: false, timedOut: false, launched: false,
      mapped: Boolean(spec && !spec.workflowJudge), custodyCwd: custodied ? workspace.cwd : null };
    record.exited = new Promise(done => { record.resolveExit = done; });
    this.processes.set(attempt.id, record);
    // A Custody claim is held by the admission above until its work starts (the barrier is inert outside tests).
    const started = () => this.executeAgent(state, scope, node, attempt, workspace, mapping, record, spec);
    (custodied ? afterBarrierWork(this.testBarrier, 'custody-claimed', { runId: state.id, nodeInstanceId: node.id, workspaceCwd: workspace.cwd }, started) : started()).catch(error => {
      try { this.failAttempt(state, this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), error instanceof CorruptionError ? 'corruption' : error.code === 'input_unavailable' ? 'input_unavailable' : 'process', error.message); }
      catch (journalError) { this.storageUnavailable(journalError); }
    }).finally(() => this.releaseAgent(state, attempt, record));
  }

  releaseAgent(state, attempt, record) {
    this.finishTaskWork(record.workId, null, record.outputBytes || 0);
    for (const key of record.keys) { this.locks.delete(key); this.store.run('DELETE FROM resource_locks WHERE resource_key = ?', key); }
    this.processes.delete(attempt.id);
    if (record.counted) for (const loopInstance of record.loops) this.bodyEnded(state, loopInstance);
    record.resolveExit?.();
    this.pump();
  }

  async executeAgent(state, scope, node, attempt, workspace, mapping, record, spec = null) {
    const config = node.config;
    const processCustody = this.custodyScopeAllows(node, record);
    const requestedEffort = resolveEffort(config.effort);
    const nativeConfiguration = state.workflow.settings.nativeConfiguration;
    const detection = await this.detect(config.provider, { processCustody });
    attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    if (this.runState(state.id) !== 'running' || !UNSTARTED.has(attempt.state) || !this.scopeActive(state, scope)) return;
    // P2 can arrive while provider detection is in flight. The process record was registered synchronously before this await,
    // so the coordinator waits for this dispatch and this check prevents the prelaunch attempt from escaping suspension.
    if (this.parentRepairDispatchPaused(state.id)) return;
    if (spec?.beforeLaunch && !spec.beforeLaunch(attempt)) return;
    let binding = mapping ? this.store.get('SELECT * FROM context_bindings WHERE id = ?', mapping.binding_id) : null;
    if (binding && !['unbound', 'ready'].includes(binding.state)) return this.failAttempt(state, attempt, 'context_unavailable', `Context binding is ${binding.state}; it cannot be used for a new write.`);
    if (!detection.available || !detection.cliPath) {
      const code = /login|authentication|account/i.test(detection.reason || '') ? 'authentication' : /billing|credits|modelProvider/i.test(detection.reason || '') ? 'billing_policy' : 'provider_unavailable';
      return this.failAttempt(state, attempt, code, detection.reason || `${config.provider} is unavailable.`);
    }
    if (processCustody && config.provider === 'codex' && detection.fixture !== true && detection.supportsCustodyExec !== true)
      return this.failAttempt(state, attempt, 'unsupported_cli', detection.custodyReason || 'The installed Codex CLI does not support the required Process Custody invocation options.');
    if (nativeConfiguration === 'inherit' && !detection.supportsInheritedConfiguration) return this.failAttempt(state, attempt, 'provider_unavailable', `${config.provider} cannot inherit native configuration.`);
    const configurationHash = canonicalHash({ provider: config.provider, accountIdentity: detection.accountIdentity, cwdIdentity: workspace.cwd_identity, nativeConfiguration, adapterVersion: ADAPTER_VERSION });
    if (binding && binding.state === 'ready') {
      if (binding.configuration_hash !== configurationHash || binding.cwd_identity !== workspace.cwd_identity) return this.failAttempt(state, attempt, 'context_unavailable', 'The Context binding was created with a different account, directory or native configuration.');
      if (!this.bindingRecord(binding).nativeSessionId) return this.failAttempt(state, attempt, 'context_unavailable', 'The Context binding has no native session to resume.');
    }
    // Preflight the native structured-output transport before any model request.
    let transport = null;
    if (config.output.format === 'json' && config.output.schema) {
      try { transport = transportSchema(config.output.schema); }
      catch (error) { return this.failAttempt(state, attempt, 'output_contract', `The output schema cannot be sent as ${config.provider} native structured output: ${error.message}`); }
    }
    record.launching = true;
    if (spec?.taskExecutionId) {
      const task = this.managedTask(state, spec.taskExecutionId);
      record.workId = this.reserveTaskWork(task, attempt, 'agent', 1);
      record.taskDeadlineMs = Date.now() + this.taskRemainingMs(task);
    }
    const nativeSessionId = binding ? this.bindingRecord(binding).nativeSessionId : null;
    const values = spec ? spec.values() : { prompt: this.inputValue(state, scope, node.id, 'prompt') };
    let prompt = this.store.readText(values.prompt.artifact.artifactId);
    const promptSources = [{ kind: 'input', artifact: ref(values.prompt.artifact) }];
    const tmp = join(this.store.workdirs, 'tmp', attempt.id);
    let attachments = null;
    if (config.attachFiles) {
      values.files = this.inputValue(state, scope, node.id, 'files');
      const manifest = this.values.readManifest(values.files.artifact);
      const folder = join(this.store.workdirs, 'attachments', attempt.id);
      const lines = [];
      for (const entry of manifest.entries) {
        const target = join(folder, ...entry.path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, this.store.readBytes(entry.artifact.artifactId).bytes, { mode: 0o444 });
        lines.push(`- ${entry.path} → ${target}`);
      }
      const section = `\n\nAttached files (read-only copies):\n${lines.join('\n') || '- (none)'}`;
      prompt += section;
      promptSources.push({ kind: 'attachments', artifact: ref(this.store.putText(section)) });
      attachments = ref(values.files.artifact);
    }
    prompt += outputContractText(config.output);
    if (config.output.format === 'json') promptSources.push({ kind: 'output-contract', artifact: ref(this.store.putText(outputContractText(config.output))) });
    const promptArtifact = this.store.putText(prompt);
    const schemaPath = transport ? join(tmp, 'output.schema.json') : null;
    const invocation = this.adapters.buildInvocation({ provider: config.provider, cliPath: detection.cliPath, model: config.model, effort: requestedEffort, prompt, cwd: workspace.cwd,
      nativeSessionId, output: transport ? { ...config.output, schema: transport.schema } : config.output, nativeConfiguration, timeoutSeconds: config.timeoutSeconds, schemaPath,
      processCustody, windowsSandboxMode: detection.windowsSandboxMode });
    invocation.env = { ...(invocation.env || process.env), DESZO_MANAGED_INVOCATION: this.runtimeInstanceId };
    let managedToolIsolation;
    try {
      managedToolIsolation = detection.fixture === true
        ? { mechanism: 'fixture-cli', checkedScopes: ['fixture'], bridgeEntries: [] }
        : await prepareManagedToolIsolation({ provider: config.provider, cliVersion: detection.cliVersion, cwd: invocation.cwd,
          args: invocation.args, bridgeScript: this.bridgeScript, runtimeInstanceId: this.runtimeInstanceId });
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
      if (this.parentRepairDispatchPaused(state.id)) return;
      return this.failAttempt(state, attempt, error.code === 'managed_tool_isolation_unavailable' ? error.code : 'managed_tool_isolation_unavailable', error.message);
    }
    if (this.parentRepairDispatchPaused(state.id)) {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
      return;
    }
    if (transport) { mkdirSync(tmp, { recursive: true }); writeFileSync(schemaPath, JSON.stringify(transport.schema)); }
    const sessionBefore = nativeSessionId ? ref(this.store.putJson({ provider: config.provider, nativeSessionId })) : null;
    const manifest = { schemaVersion: 1, runId: state.id, attemptId: attempt.id, provider: config.provider, requestedModel: config.model, requestedEffort,
      cliExecutable: invocation.command, cliVersion: detection.cliVersion || '', arguments: invocation.args, cwd: invocation.cwd, cwdIdentity: workspace.cwd_identity,
      nativeConfiguration, configurationHash, environmentPolicy: 'subscription-only', stdin: invocation.stdin === null ? null : ref(this.store.putText(invocation.stdin)),
      managedToolIsolation: { ...managedToolIsolation, runtimeInstanceId: this.runtimeInstanceId },
      timeoutSeconds: config.timeoutSeconds, nativeSessionBefore: sessionBefore, ...(attachments ? { attachments } : {}) };
    assertValid('attempt-record.schema.json', 'invocation', manifest, 'Invocation manifest');
    let current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    this.store.transaction(() => {
      const events = [this.commitInputs(state, current, values, { prompt: ref(promptArtifact), promptSources, binding })];
      const invocationArtifact = this.store.putJson(manifest);
      this.store.run('UPDATE attempts SET invocation_artifact_id = ? WHERE id = ?', invocationArtifact.artifactId, attempt.id);
      events.push({ type: 'attempt.invocation_committed', nodeInstanceId: current.node_instance_id, attemptId: attempt.id, payload: { manifest: ref(invocationArtifact) } });
      if (binding) {
        const [event, updated] = this.bindingTransition(binding, 'writing', 'Agent invocation reserved the native conversation.', { accountIdentity: detection.accountIdentity, configurationHash, model: config.model });
        events.push(event); binding = updated;
      }
      this.store.appendEvents(state.id, events);
    });
    // Crash point: the invocation is durable, and the provider has not been launched.
    custodyFaultPoint('after_invocation_commit');
    if (this.parentRepairDispatchPaused(state.id)) {
      if (!this.recordParentRepairLaunchWithdrawn(state.id, attempt.id, null, binding)) this.restoreBindingBeforeLaunch(state, binding);
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
      return;
    }
    const isolationIssue = this.linkedRepairWorkspaceIssueForRun(state.id);
    if (isolationIssue) {
      this.refuseLinkedRepairExecution(state, isolationIssue);
      this.restoreBindingBeforeLaunch(state, binding);
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
      return;
    }
    // ADR-0006: a host-bound runtime charges every provider invocation to the shared ledger before its CLI is launched.
    const providerPermit = await this.reserveHostProviderInvocation(state.id, attempt.id);
    if (providerPermit?.refused) {
      if (this.parentRepairDispatchPaused(state.id)) {
        if (!this.recordParentRepairLaunchWithdrawn(state.id, attempt.id, null, binding)) this.restoreBindingBeforeLaunch(state, binding);
        rmSync(tmp, { recursive: true, force: true });
        rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
        return;
      }
      return this.failAttempt(state, current, 'host_refused', `The Local Control Host refused this provider invocation: ${providerPermit.reason}.`,
        { source: 'host', causeKnowledge: 'direct_fact', executionCertainty: 'not_started', sideEffectCertainty: 'none_proven', rawCode: 'host_refused' });
    }
    if (this.parentRepairDispatchPaused(state.id)) {
      await this.settleHostProviderInvocation(providerPermit, { launched: false, evidence: 'Parent suspension was recorded before provider launch.' });
      if (!this.recordParentRepairLaunchWithdrawn(state.id, attempt.id, null, binding)) this.restoreBindingBeforeLaunch(state, binding);
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
      return;
    }
    if (spec?.beforeLaunch && !spec.beforeLaunch(current)) {
      if (providerPermit) await this.settleHostProviderInvocation(providerPermit, { launched: false, evidence: 'The Judge attention evidence changed before provider launch.' });
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
      return;
    }
    let outcome;
    try { outcome = await this.runProcess(state, current, node, invocation, record); }
    catch (error) { await this.settleHostProviderInvocation(providerPermit, { launched: true, evidence: `provider invocation ended with an exception: ${error.message}` }); throw error; }
    await this.settleHostProviderInvocation(providerPermit, { launched: outcome.launched === true, evidence: outcome.launched ? 'provider invocation launched' : `provider invocation did not launch: ${outcome.error || 'no launch'}` });
    rmSync(tmp, { recursive: true, force: true });
    rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
    return this.settleAgentProcess(state, node, attempt, { config, requestedEffort, workspace, binding, transport, spec, record }, outcome);
  }

  // The settlement of one finished CLI process: its output contract, transitions and committed outputs. An uninterrupted attempt
  // and an attempt resumed under Process Custody reach it through this one method.
  async settleAgentProcess(state, node, attempt, { config, requestedEffort, workspace, binding, transport, spec, record }, outcome) {
    let current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    if (!outcome.launched) {
      if (state.linkedRepairIsolationFailure) return;
      if (outcome.errorCode === 'parent_suspension_requested' && this.parentRepairDispatchPaused(state.id)) {
        if (!this.recordParentRepairLaunchWithdrawn(state.id, attempt.id, record.child?.custodyId ?? null, binding)) this.restoreBindingBeforeLaunch(state, binding);
        return;
      }
      this.restoreBindingBeforeLaunch(state, binding);
      // A Stop that arrived before the launch is a cancellation, not a provider failure.
      if (record.stopRequested) return this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(current, 'canceled', record.stopReason || 'Stopped by the user.', null,
        { source: 'external_control', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'not_started', sideEffectCertainty: 'none_proven' })));
      const rawCode = typeof outcome.errorCode === 'string' ? outcome.errorCode : null;
      const launchSource = rawCode && (/^(custody|host_)/i.test(rawCode) || rawCode === 'launch_failed') ? 'host' : 'provider';
      const launchError = normalizeAttemptErrorCode(rawCode, { source: launchSource, operation: 'provider_launch' });
      // Preserve the existing canonical attempt.error value for this Host refusal while the new outcome records its Host provenance.
      if (rawCode === 'launch_failed') launchError.canonicalCode = 'provider_unavailable';
      const definitelyNotStarted = launchSource === 'provider' || ['launch_failed', 'custody_not_launched', 'custody_admission_lost'].includes(rawCode);
      return this.failAttempt(state, current, launchError.canonicalCode, `The CLI could not be started: ${outcome.error}`,
        { evidence: ref(this.store.putJson({ errorCode: outcome.errorCode ?? null, error: outcome.error ?? null })), source: launchSource,
          operation: 'provider_launch', rawCode, executionCertainty: definitelyNotStarted ? 'not_started' : 'unresolved',
          sideEffectCertainty: definitelyNotStarted ? 'none_proven' : 'unknown',
          observedState: launchSource === 'host' ? { hostState: definitelyNotStarted ? 'launch_failed' : 'unavailable' } : {} });
    }
    const parser = outcome.parser.state;
    if (outcome.captureError) {
      const reason = `Capturing the CLI output failed (${outcome.captureError.code || 'error'}: ${outcome.captureError.message}); the process was stopped and nothing was committed.`;
      try {
        return this.failAttempt(state, current, 'capture_failed', reason, binding ? { binding, bindingTo: 'needs_review', bindingReason: 'Output capture failed; native history may have advanced.' } : {});
      } catch (error) { return this.storageUnavailable(error); }
    }
    const evidence = () => ref(this.store.putJson({ exitCode: outcome.code, signal: outcome.signal ?? null, providerError: parser.error, stderrTail: outcome.stderrTail,
      ...(parser.diagnostics?.length ? { providerDiagnostics: parser.diagnostics } : {}) }));
    if (['host_lost', 'host_stopped', 'refused_host_restart'].includes(outcome.signal)) {
      return this.store.transaction(() => {
        const events = this.attemptTransition(current, 'interrupted', `The Host ended the CLI without a recorded result (${outcome.signal}); the attempt outcome is unknown.`, null,
          { source: 'host', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'unresolved', observedState: { hostState: outcome.signal } });
        if (binding) events.push(this.bindingTransition(binding, 'needs_review', 'The Host stopped the CLI during a native write; native history may have advanced.')[0]);
        this.store.appendEvents(state.id, events);
      });
    }
    if (['spool_limit_exceeded', 'spool_failed', 'spool_incomplete'].includes(outcome.signal)) {
      return this.failAttempt(state, current, 'capture_failed', 'The Host could not keep the complete output of the CLI, so the attempt is not accepted.',
        { source: 'host', executionCertainty: 'unresolved', observedState: { hostState: outcome.signal } });
    }
    // F3: a Host stop is a stop outcome, never a result. An end whose tree is unproven is classified as such first, as before, unless it is a Host
    // stop; a Host stop keeps the Engine's own Stop and timeout outcomes, settled below.
    const hostStop = STOP_FAMILY.has(outcome.signal) || (outcome.signal === 'tree_not_ended' && STOP_FAMILY.has(outcome.custody));
    if (outcome.signal === 'tree_not_ended' && !hostStop) {
      return this.failAttempt(state, current, 'process', 'The CLI exited, but the Host has not proven that its process tree ended, so the attempt is not accepted; its workspace stays held until the Host proves the end.',
        { ...(binding ? { binding, bindingTo: 'needs_review', bindingReason: 'The CLI may still have written before the Host proved its end; native history may have advanced.' } : {}),
          source: 'host', executionCertainty: 'unresolved', observedState: { hostState: 'exited', processTreeEnded: false } });
    }
    const reported = parser.sessionId && binding && !this.bindingRecord(binding).nativeSessionId ? { nativeSessionId: parser.sessionId } : {};
    const native = binding ? { binding, bindingTo: 'needs_review', bindingReason: 'The invocation did not complete normally; native history may have advanced.', bindingChanges: reported } : {};
    const succeeded = outcome.code === 0 && outcome.signal == null && !parser.error && parser.terminal && parser.finalText !== null;
    if (record.stopRequested && !succeeded) {
      // A managed runtime shutdown is not a user Stop: the attempt's outcome is unknown, so it is interrupted, not canceled.
      return this.store.transaction(() => {
        const events = record.runtimeShutdown
          ? this.attemptTransition(current, 'interrupted', 'Runtime shutdown; the attempt outcome is unknown.')
          : this.attemptTransition(current, 'canceled', record.stopReason || 'Stopped by the user.', null,
            { source: record.stopSource || 'external_control', code: 'interrupted', causeKnowledge: 'direct_fact',
              executionCertainty: Number.isInteger(outcome.code) || outcome.processTreeEnded === true ? 'completed' : 'unresolved',
              sideEffectCertainty: 'unknown', observedState: { ...(outcome.signal ? { hostState: outcome.signal } : {}),
                ...(outcome.processTreeEnded === true ? { processTreeEnded: true } : {}), ...(Number.isInteger(outcome.code) ? { exitCode: outcome.code } : {}) } });
        if (binding) events.push(this.bindingTransition(binding, 'needs_review', native.bindingReason, reported)[0]);
        this.store.appendEvents(state.id, events);
      });
    }
    const lastDiagnostic = parser.diagnostics?.at(-1);
    if (record.timedOut) return this.failAttempt(state, current, 'timeout', `The attempt exceeded ${config.timeoutSeconds} seconds of active process time.${lastDiagnostic ? ` Last provider diagnostic: ${lastDiagnostic}` : ''}`,
      { evidence: evidence(), ...native, source: 'workflow', executionCertainty: 'completed', observedState: Number.isInteger(outcome.code) ? { exitCode: outcome.code } : {} });
    // A Host stop the Engine did not ask for is not settled as a result: an unproven tree is named as such, a deadline is a timeout, and any other
    // stop is a cancellation.
    if (outcome.signal === 'tree_not_ended') {
      return this.failAttempt(state, current, 'process', `The Host stopped the CLI (${outcome.custody}), but has not proven that its process tree ended, so the attempt is not accepted; its workspace stays held until the Host proves the end.`,
        { evidence: evidence(), ...native, source: 'host', executionCertainty: 'unresolved', observedState: { hostState: outcome.custody || 'unknown', processTreeEnded: false } });
    }
    if (STOP_FAMILY.has(outcome.signal)) {
      if (outcome.signal === 'deadline_terminated') return this.failAttempt(state, current, 'timeout', 'The Host ended the CLI at its admitted deadline, so the attempt is not accepted.',
        { evidence: evidence(), ...native, source: 'workflow', executionCertainty: 'completed',
          observedState: { hostState: outcome.signal, processTreeEnded: true, ...(Number.isInteger(outcome.code) ? { exitCode: outcome.code } : {}) } });
      return this.store.transaction(() => {
        const events = this.attemptTransition(current, 'canceled', `The Host stopped the CLI (${outcome.signal}) without a Stop from this Engine.`, null,
          { source: 'host', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'completed', sideEffectCertainty: 'unknown',
            observedState: { hostState: outcome.signal, processTreeEnded: outcome.processTreeEnded === true,
              ...(Number.isInteger(outcome.code) ? { exitCode: outcome.code } : {}) } });
        if (binding) events.push(this.bindingTransition(binding, 'needs_review', native.bindingReason, reported)[0]);
        this.store.appendEvents(state.id, events);
      });
    }
    if (!succeeded) {
      const text = [parser.error, outcome.stderrTail, lastDiagnostic].filter(Boolean).join('\n');
      if (outcome.code === 0 && !parser.error) return this.failAttempt(state, current, 'output_contract', parser.formatError || (parser.terminal ? 'The CLI reported no final answer.' : 'The CLI exited without a terminal event.'), { evidence: evidence(), ...native });
      return this.failAttempt(state, current, parser.protocolError ? 'provider_protocol' : this.adapters.classifyFailure(text), text.trim().slice(0, 4000) || `The CLI exited with code ${outcome.code}.`,
        { evidence: evidence(), ...native, source: 'provider', executionCertainty: 'completed', observedState: { exitCode: outcome.code, processTreeEnded: true } });
    }
    if (binding && !parser.sessionId) return this.failAttempt(state, current, 'output_contract', 'The CLI did not report a native session ID, so continuation is unavailable.', { evidence: evidence(), ...native });
    let jsonArtifact = null, captured = null, parsed;
    if (config.output.format === 'json') {
      try { parsed = parseJsonAnswer(parser.finalText); if (transport) parsed = transport.decode(parsed); }
      catch (error) { return this.failAttempt(state, current, 'output_contract', `The final answer is not valid JSON: ${error.message}`, { evidence: evidence(), ...native }); }
      if (config.output.schema) {
        const issues = compileOutputSchema(config.output.schema)(parsed);
        if (issues.length) return this.failAttempt(state, current, 'output_contract', `The final answer does not match the output schema: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`, { evidence: evidence(), ...native });
      }
      jsonArtifact = this.store.putJson(parsed);
    }
    if (spec?.workflowJudge) custodyFaultPoint('before_workflow_judge_validation');
    if (spec?.check) {
      let problem;
      try { problem = spec.check(parsed, current); } catch (error) { problem = error.message; }
      if (problem) {
        try { spec.reject?.(parsed, current, problem); }
        catch (error) { process.stderr.write(`Could not record rejected Judge output for ${current.id}: ${error.message}\n`); }
        return this.failAttempt(state, current, 'output_contract', problem, { evidence: evidence(), ...native });
      }
    }
    if (spec?.workflowJudge) custodyFaultPoint('after_workflow_judge_validation');
    if (config.captures) {
      try { captured = this.values.putSet(captureFiles(this.store, workspace.cwd, config.captures, 'output_contract')); }
      catch (error) { return this.failAttempt(state, current, 'output_contract', `Declared output capture failed: ${error.message}`, { evidence: evidence(), ...native }); }
    }
    // ADR-0008: a linked repair's Judge proposal is validated before anything commits; a refused proposal fails the attempt.
    const lifecycle = this.lifecycleProposalFor(state, node, parser.finalText);
    if (lifecycle.kind === 'refuse') return this.failAttempt(state, current, lifecycle.code, lifecycle.message, { evidence: evidence(), ...native });
    let p5CandidateCapture = null;
    try { p5CandidateCapture = await this.captureProtectedSelfRepairDeveloperCandidate({ state, node, attempt: current, workspace,
      binding, record, outcome, current }); }
    catch (error) {
      const terminal = record.child?.terminalStatus;
      if (p5CaptureFailureDisposition(error) === 'hold') {
        // A transient Host or dependency failure is not evidence about the candidate. The exact capture (same Attempt, durable
        // anchor and Git commit intent) is retried on a bounded durable budget, and fails closed when the budget is spent.
        // An Engine shutdown is never a Stop and spends no hold: the Attempt stays as it is, and the next Engine continues the same
        // durable capture through Custody re-delivery (review recheck N1).
        if (record.runtimeShutdown || this.closing) return null;
        const previous = this.store.readEvents(state.id).filter(event => event.type === 'self_repair.capture_held'
          && this.store.readJson(event.payload.record.artifactId).attemptId === current.id).length;
        const decision = p5CaptureHoldDecision(previous);
        if (decision.action === 'fail')
          return this.failAttempt(state, current, 'p5_capture_unavailable', `P5 candidate capture stayed unavailable after ${previous} bounded retries (${error.code}).`,
            { source: 'host', executionCertainty: 'completed', sideEffectCertainty: 'unknown',
              observedState: { hostState: terminal?.state || 'exited', processTreeEnded: terminal?.processTreeEnded === true } });
        const holdRecord = { schemaVersion: 1, kind: 'ProtectedSelfRepairCaptureHold', runId: state.id, attemptId: current.id,
          code: String(error.code).slice(0, 128), holdNumber: decision.holdNumber, maxHolds: P5_CAPTURE_HOLD_DELAYS_MS.length,
          retryAt: new Date(Date.now() + decision.delayMs).toISOString() };
        validateP5Contract('captureHold', holdRecord);
        const hold = this.store.putJson(holdRecord);
        this.store.appendEvents(state.id, [{ type: 'self_repair.capture_held', nodeInstanceId: null, attemptId: null,
          payload: { record: { artifactId: hold.artifactId, sha256: hold.sha256 } } }]);
        // The hold is live work of this Run (review recheck): the Run stays running and is never parked in an Owner-decision
        // wait. Root Stop aborts a waiting hold at once (cancelling the held Attempt). During an in-flight retry it is recorded
        // on the record instead: the retry's own authority checks (candidate invalidation) fail it closed, and whatever the retry
        // left unsettled is cancelled when it returns.
        const supersededReason = () => record.stopRequested || this.runState(state.id) === 'stopping'
          ? 'Root Stop superseded the held P5 candidate capture.'
          : `The Run left running (${this.runState(state.id)}) while the P5 candidate capture was held; the capture was not retried.`;
        const cancelHeld = reason => {
          try {
            this.store.transaction(() => {
              const now = this.store.get('SELECT * FROM attempts WHERE id = ?', current.id);
              if (now && !TERMINAL_ATTEMPT.has(now.state))
                this.store.appendEvents(state.id, this.attemptTransition(now, 'canceled', reason, null,
                  { source: 'external_control', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'completed', sideEffectCertainty: 'unknown' }));
            });
          } catch (journalError) { this.storageUnavailable(journalError); }
        };
        // A Stop already requested (or a Run no longer running) is never turned into a hold: the Attempt settles now.
        if (record.stopRequested || this.runState(state.id) !== 'running') {
          cancelHeld(supersededReason());
          return null;
        }
        const holdKey = `p5-capture-hold:${current.id}:${decision.holdNumber}`;
        if (!this.processes.has(holdKey)) {
          const abortController = new AbortController();
          let timer = null, retrying = false, ended = null;
          // `exited` lets an Engine shutdown await an in-flight retry before the Store closes (review recheck 4c).
          // The held Attempt keeps its workspace locks (review recheck 3): the hold takes them from the record, so `releaseAgent`
          // frees none, and they are freed only when the hold ends. A retry hands them back to the record; a nested hold takes
          // them again, otherwise they are freed when the retry returns.
          const placeholder = { runId: state.id, attemptId: current.id, loops: [], launched: false, p5CaptureHold: true, abortController,
            keys: record.keys, exited: new Promise(done => { ended = done; }) };
          record.keys = [];
          const freeKeys = keys => {
            for (const key of keys) { this.locks.delete(key); this.store.run('DELETE FROM resource_locks WHERE resource_key = ?', key); }
          };
          const release = () => {
            clearTimeout(timer); this.processes.delete(holdKey);
            try { freeKeys(placeholder.keys); freeKeys(record.keys); } catch (journalError) { this.storageUnavailable(journalError); }
            placeholder.keys = []; record.keys = []; ended();
            if (!this.closing) queueMicrotask(() => this.pump());
          };
          abortController.signal.addEventListener('abort', () => {
            // An Engine shutdown only disposes a waiting timer: the durable hold count and Custody re-delivery continue the same
            // capture in the next Engine. An in-flight retry is left to finish and settles through `release`.
            if (placeholder.runtimeShutdown) { if (!retrying) release(); return; }
            // During an in-flight retry the retry is told to stop and settles the Attempt itself, exactly once.
            if (retrying) { record.stopRequested = true; record.stopSource = 'external_control'; record.stopReason = placeholder.stopReason || 'Stopped by root Stop.'; return; }
            // Only a Root or scoped Stop aborts a waiting hold (a shutdown returned above).
            release();
            cancelHeld(placeholder.stopReason ? `${placeholder.stopReason} The held P5 candidate capture was cancelled.` : supersededReason());
          }, { once: true });
          timer = setTimeout(() => {
            const latest = this.store.get('SELECT * FROM attempts WHERE id = ?', current.id);
            if (!latest || TERMINAL_ATTEMPT.has(latest.state)) return release();
            // A Run that stopped or drained meanwhile never retries; the held Attempt settles as superseded.
            if (record.stopRequested || this.runState(state.id) !== 'running') {
              cancelHeld(supersededReason());
              return release();
            }
            retrying = true;
            record.keys = placeholder.keys; placeholder.keys = [];
            // A retry that cannot even reach the capture never leaves the Attempt held: it fails closed with its reason recorded.
            this.settleAgentProcess(state, node, latest, { config, requestedEffort, workspace, binding, transport, spec, record }, outcome)
              .catch(retryError => {
                try {
                  const now = this.store.get('SELECT * FROM attempts WHERE id = ?', current.id);
                  if (now && !TERMINAL_ATTEMPT.has(now.state))
                    this.failAttempt(state, now, 'p5_capture_retry_failed', `The bounded P5 capture retry could not run: ${retryError.code || 'error'}: ${retryError.message}`.slice(0, 2000),
                      { source: 'engine', executionCertainty: 'completed', sideEffectCertainty: 'unknown' });
                } catch (journalError) { this.storageUnavailable(journalError); }
              })
              .finally(() => {
                // A Stop during the retry: whatever the retry left unsettled is cancelled now, never later.
                if (record.stopRequested) cancelHeld('Root Stop superseded the retried P5 candidate capture.');
                release();
              });
          }, decision.delayMs);
          timer.unref?.();
          this.processes.set(holdKey, placeholder);
        }
        process.stderr.write(`P5 candidate capture for Attempt ${current.id} is held (${error.code}); bounded retry ${decision.holdNumber}/${P5_CAPTURE_HOLD_DELAYS_MS.length}.\n`);
        return null;
      }
      return this.failAttempt(state, current, error.code || 'capture_failed', `P5 candidate capture failed closed: ${error.message}`,
        { source: 'engine', executionCertainty: 'completed', sideEffectCertainty: 'unknown',
          observedState: { hostState: terminal?.state || 'exited', processTreeEnded: terminal?.processTreeEnded === true,
            spoolComplete: terminal?.spoolComplete === true, ...(Number.isInteger(outcome.code) ? { exitCode: outcome.code } : {}) } });
    }
    let commitAdmission = null;
    if (spec?.prepareCommit) {
      try { commitAdmission = await spec.prepareCommit(parsed, current); }
      catch (error) {
        return this.failAttempt(state, current, error.code || 'p5_admission_unavailable',
          'The Judge decision was not committed because its Engine-side admission check failed: ' + error.message,
          { evidence: evidence(), source: 'engine', executionCertainty: 'completed', observedState: { hostState: 'settled' } });
      }
    }
    this.store.transaction(() => {
      const textArtifact = this.store.putText(parser.finalText);
      const outputValues = { text: textValue(textArtifact), ...(jsonArtifact ? { json: jsonValue(jsonArtifact) } : {}), ...(captured ? { files: captured } : {}) };
      const sessionArtifact = this.store.putJson({ provider: config.provider, nativeSessionId: parser.sessionId ?? null });
      const usage = parser.usage ? ref(this.store.putJson(parser.usage)) : null;
      const events = [this.commitOutputs(state, current, outputValues, { provider: config.provider, requestedModel: config.model, requestedEffort, observedModel: parser.model, nativeSession: ref(sessionArtifact), usage })];
      if (binding) {
        const first = !this.bindingRecord(binding).nativeSessionId;
        const [event, updated] = this.bindingTransition(binding, 'ready', 'Invocation committed; native conversation advanced.', { nativeSessionId: parser.sessionId });
        if (first) events.push({ type: 'context.bound', payload: { bindingId: binding.id, provider: config.provider, nativeSessionRef: ref(sessionArtifact), cwdIdentity: workspace.cwd_identity } });
        events.push(event); binding = updated;
      }
      spec?.commit?.(parsed, events, current, { provider: config.provider, requestedModel: config.model, observedModel: parser.model,
        p5RepairAdmission: commitAdmission });
      if (this.store.get('SELECT outcome_id FROM failure_outcomes WHERE attempt_id = ?', current.id)) {
        const reconciled = this.failureOutcomeEvent(current, { source: 'host', code: 'custody_unresolved', causeKnowledge: 'direct_fact', attemptState: 'succeeded',
          executionCertainty: 'completed', observedState: { hostState: 'exited', processTreeEnded: true, exitCode: outcome.code, spoolComplete: true } });
        if (reconciled) events.push(reconciled);
      }
      events.push(...this.attemptTransition(current, 'succeeded', 'Outputs committed after a successful terminal event and process exit.'));
      if (p5CandidateCapture) events.push({ type: 'self_repair.candidate_captured', payload: { record: p5CandidateCapture.candidateArtifact },
        nodeInstanceId: null, attemptId: null });
      if (lifecycle.kind === 'intent') events.push(...this.openLifecycleIntent(state, current, current.node_instance_id, lifecycle.proposal));
      this.store.appendEvents(state.id, events);
    });
    // Crash point: the outputs and the attempt's success are durable, and nothing after them has run yet.
    custodyFaultPoint('after_settle');
    custodyFaultPoint(`after_settle:${node.id}`);
    await spec?.afterCommit?.(record, current);
    if (lifecycle.kind === 'intent' && this.lifecycleHost) {
      const request = this.lifecycleHostRequest(state.id);
      if (request) this.emit('lifecycle.operation_requested', request);
    }
  }

  restoreBindingBeforeLaunch(state, binding) {
    if (!binding || binding.state !== 'writing') return;
    const to = this.bindingRecord(binding).nativeSessionId ? 'ready' : 'unbound';
    this.store.transaction(() => this.store.appendEvents(state.id, [this.bindingTransition(binding, to, 'No process was launched; the native conversation did not change.')[0]]));
  }

  runProcess(state, attempt, node, invocation, record) {
    return new Promise(resolvePromise => {
      const parser = record.parser || this.adapters.createParser(node.config.provider, { output: node.config.output });
      // Capture failures (for example a full disk) happen in stream callbacks and timers, outside
      // the awaited invocation: contain them, stop the owned process and report them distinctly.
      const fault = error => this.captureFault(record, error);
      // Every byte is durable as it arrives; the stream manifests are published when the process ends (ADR-0002 section 1).
      const extended = this.store.get('SELECT journal_version AS version FROM runs WHERE id = ?', state.id).version >= 2;
      // A resumed attempt continues the streams its earlier Engine committed (Process Custody); a fresh one starts empty.
      // A Host-owned CLI's normalized stream is committed only together with its stdout (in commit), so a resume's normalized
      // prefix is always derived from committed stdout. Its timers and size thresholds therefore do not flush it on their own.
      const custodied = Boolean(record.custodyResume) || this.custodyScopeAllows(node, record);
      const recorder = (stream, mediaType) => new StreamRecorder({ store: this.store, runId: state.id, attempt, stream, mediaType, onFault: fault, extended,
        resume: record.custodyResume ? this.custodyResumeSeed(attempt.id, stream) : null, deferFlush: custodied && stream === 'normalized' });
      const streams = { stdout: recorder('stdout', 'application/octet-stream'), stderr: recorder('stderr', 'application/octet-stream'), normalized: recorder('normalized', 'application/x-ndjson') };
      // Multibyte UTF-8 characters may be split across chunks; decode as a stream.
      const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
      let stdoutRemainder = '', stderrTail = '', settled = false, timer = null;
      if (!record.exited) record.exited = new Promise(done => { record.resolveExit = done; });
      // A Host-owned CLI may run for the timeout plus a grace; the Engine's own timer still reports a timeout first while it lives.
      const custodyDeadlineMs = (node.config.timeoutSeconds + 5) * 1000;
      let child;
      try {
        const custodyProvider = record.provider || node.config.provider;
        if (record.custodyResume) child = this.attachCustody(state.id, attempt, { provider: custodyProvider, deadlineMs: custodyDeadlineMs });
        else if (this.custodyScopeAllows(node, record)) {
          // A Custody-scoped attempt never falls back to an ordinary launch: when the Host is unavailable it fails here, closed.
          if (this.custodyUnavailable) throw Object.assign(new Error(this.custodyUnavailable), { code: 'custody_unavailable' });
          child = this.launchCustody(state.id, attempt, invocation, { provider: custodyProvider, deadlineMs: custodyDeadlineMs });
        }
        else child = this.launchContained(state.id, invocation);
      }
      catch (error) { resolvePromise({ launched: false, error: error.message, errorCode: error.code || null, parser }); return; }
      record.child = child;
      // A Host-owned CLI is acknowledged only for bytes these recorders have committed: flush first, then report the absolute
      // committed offsets. Journal-derived offsets make the resume cursor exact even if this acknowledgement is lost.
      if (child.custody) child.commit = () => {
        streams.stdout.flush();
        streams.stderr.flush();
        // The normalized stream follows stdout: it holds lines derived from the stdout bytes committed just above.
        streams.normalized.flush();
        return { stdout: streams.stdout.committedBytes, stderr: streams.stderr.committedBytes };
      };
      const finish = (result, { complete = false } = {}) => {
        if (settled) return; settled = true; clearTimeout(timer);
        const endingReason = result.launched ? (result.signal ? `process ended by signal ${result.signal}` : `process exited with code ${result.code}`) : (result.error || 'process did not launch');
        let manifests = {};
        try { manifests = Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, stream.close(endingReason, { complete })])); }
        catch (error) { fault(error); }
        resolvePromise({ ...result, parser, stderrTail: stderrTail.slice(-8000), captureError: record.captureError ?? null, streams: manifests });
      };
      child.once('error', error => { if (!record.launched) finish({ launched: false, error: error.message, errorCode: error.code || null }); });
      child.once('spawn', () => { try {
        record.launched = true;
        this.markTaskWorkLaunched(record.workId);
        if (record.loops.length) { record.counted = true; for (const loopInstance of record.loops) this.bodyStarted(state, loopInstance); }
        // A Host-owned CLI carries its own creation identity. A resumed one's running transition is already durable.
        const startIdentity = child.startIdentity ?? `${child.pid}@${new Date().toISOString()}`;
        if (!record.custodyResume && !crashBeforeIdentityPoint()) {
          this.store.run('UPDATE attempts SET process_id = ?, process_start_identity = ?, supervisor_generation = ?, started_at = ? WHERE id = ?', child.pid, startIdentity, this.supervisorGeneration, nowIso(), attempt.id);
          const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
          this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(current, 'running', 'CLI process launched.', { pid: child.pid, startIdentity, supervisorGeneration: this.supervisorGeneration })));
        }
        const timeoutMs = Math.max(1, Math.min(node.config.timeoutSeconds * 1000, record.taskDeadlineMs ? record.taskDeadlineMs - Date.now() : Infinity));
        timer = record.timer = setTimeout(() => {
          record.timedOut = true;
          if (record.taskExecutionId && Date.now() >= record.taskDeadlineMs) {
            const task = this.managedTask(state, record.taskExecutionId); task.data.incompleteReason = 'aggregate_budget_exhausted'; this.saveManagedTask(task, null, 'budget');
          }
          this.terminateLaunched(child);
        }, timeoutMs);
        if (record.stopRequested) this.terminateLaunched(child);
      } catch (error) { fault(error); } });
      child.stdout.on('data', chunk => {
        record.outputBytes = (record.outputBytes || 0) + chunk.length;
        try {
          if (!record.replaying) streams.stdout.add(chunk);
          const lines = (stdoutRemainder + stdoutDecoder.write(chunk)).split(/\r?\n/);
          stdoutRemainder = lines.pop();
          for (const line of lines) this.observe(parser, line, record.replaying ? record.replayNormalized : streams.normalized);
        } catch (error) { fault(error); }
      });
      child.stderr.on('data', chunk => {
        record.outputBytes = (record.outputBytes || 0) + chunk.length;
        try { if (!record.replaying) streams.stderr.add(chunk); stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-16000); } catch (error) { fault(error); }
      });
      child.once('close', (code, signal) => {
        try {
          stdoutRemainder += stdoutDecoder.end();
          stderrTail += stderrDecoder.end();
          if (stdoutRemainder) this.observe(parser, stdoutRemainder, streams.normalized);
        } catch (error) { fault(error); }
        // A shim failure exit means the CLI never ran; it is reported as a launch failure, not as the CLI's own result.
        const shimFailure = this.supervisor ? shimFailureOf(code) : null;
        if (shimFailure) finish({ launched: false, error: `The launch shim could not start the CLI (${shimFailure}).` });
        // A Host-owned CLI's stream is complete only when the Host confirms its spool; a tail the Host could not keep stays partial.
        else if (record.launched) finish({ launched: true, code, signal, custody: child.custodyState ?? null }, { complete: !child.custody || child.spoolComplete === true });
        else finish({ launched: false, error: 'Process closed before launch.' });
      });
      // A resumed CLI's committed prefix is replayed through the same parser path without writing it again. Its normalized
      // output must equal what the earlier Engine committed; if it does not, the resume faults rather than guessing.
      if (record.custodyResume) {
        const replay = this.custodyReplay(attempt.id), sink = { parts: [], add(chunk) { this.parts.push(chunk); } };
        record.replaying = true; record.replayNormalized = sink;
        try {
          if (replay.stdout.length) child.stdout.emit('data', replay.stdout);
          if (replay.stderr.length) child.stderr.emit('data', replay.stderr);
        } finally { record.replaying = false; record.replayNormalized = null; }
        const replayed = Buffer.concat(sink.parts);
        if (!replayed.subarray(0, replay.normalized.length).equals(replay.normalized)) {
          fault(Object.assign(new Error('The replayed output diverged from the normalized output committed before the restart.'), { code: 'custody_resume_divergence' }));
        } else if (replayed.length > replay.normalized.length) streams.normalized.add(replayed.subarray(replay.normalized.length));
      }
    });
  }

  captureFault(record, error) {
    if (record.captureError) return;
    record.captureError = error;
    if (record.launched) this.terminateLaunched(record.child);
  }

  // The store itself could not be written: refuse new work and stop owned processes. Durable
  // state stays as last committed; restart recovery marks the affected runs interrupted.
  storageUnavailable(error) {
    this.recoveryBlocked = `The runtime could not write its store (${error.code || 'error'}: ${error.message}). Free space or fix the data folder, then restart; affected runs are recovered as interrupted.`;
    this.closing = true;
    for (const record of this.processes.values()) { record.stopRequested = true; if (record.launched) this.terminateLaunched(record.child); }
    process.stderr.write(`${this.recoveryBlocked}\n`);
  }

  observe(parser, line, normalizedBatch) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      const message = 'Malformed JSONL protocol event; exact provider bytes remain in the raw stdout stream.';
      parser.state.protocolError = true;
      parser.state.error ??= message;
      normalizedBatch.add(Buffer.from(JSON.stringify({ protocolError: message }) + '\n'));
      return;
    }
    const normalized = parser.feed(event);
    const observation = { sessionId: normalized.sessionId || undefined, text: normalized.text || undefined, model: normalized.model || undefined,
      diagnostic: normalized.diagnostic || undefined, terminal: parser.state.terminal || undefined, error: parser.state.error || undefined,
      protocolError: normalized.protocolError || undefined, providerEvent: normalized.providerEvent };
    if (Object.values(observation).some(value => value !== undefined)) normalizedBatch.add(Buffer.from(JSON.stringify(observation) + '\n'));
  }

  // ---------- Stop ----------
  cancelLoops(runId, events, reason) {
    for (const loop of this.store.all(`SELECT * FROM loop_executions WHERE run_id = ? AND state IN ('running','paused')`, runId)) {
      this.store.run(`UPDATE loop_executions SET state = 'canceled', pause_reason = NULL WHERE run_id = ? AND loop_node_id = ?`, runId, loop.loop_node_id);
      this.store.run(`UPDATE loop_iterations SET outcome = 'canceled', ended_at = ? WHERE run_id = ? AND loop_node_id = ? AND outcome IN ('running','paused')`, nowIso(), runId, loop.loop_node_id);
      const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', loop.attempt_id);
      if (!TERMINAL_ATTEMPT.has(attempt.state)) events.push(...this.attemptTransition(attempt, 'canceled', reason, null,
        { source: 'external_control', code: 'interrupted', causeKnowledge: 'direct_fact',
          executionCertainty: UNSTARTED.has(attempt.state) ? 'not_started' : 'unknown',
          sideEffectCertainty: UNSTARTED.has(attempt.state) ? 'none_proven' : 'unknown' }));
    }
  }

  stopRun(runId, body) {
    this.validateBody('stopRequest', body);
    let shouldSignalProcesses = false;
    return this.idempotent(`POST /runs/${runId}/stop`, body.requestId, body, () => {
      const row = this.requireRun(runId);
      if (TERMINAL_RUN.has(row.state)) {
        this.store.transaction(() => this.invalidateProtectedSelfRepairForStopInTransaction?.(runId, row.state));
        return { status: 200, body: { runId, state: row.state, requestId: body.requestId } };
      }
      if (row.state !== 'stopping') {
        shouldSignalProcesses = true;
        this.store.transaction(() => {
          this.invalidateProtectedSelfRepairForStopInTransaction?.(runId, row.state);
          const events = [this.runEvent(row, 'stopping', 'Root Stop requested.')];
          this.workflowJudgeSupersedeAttentionInTransaction(runId, 'Owner Stop superseded pending Judge attention.', events);
          this.workflowJudgeSupersedeQuestionsInTransaction(runId, 'Owner Stop superseded pending Judge question.', events);
          const loopAttempts = new Set([...this.store.all('SELECT attempt_id FROM loop_executions WHERE run_id = ?', runId).map(item => item.attempt_id), ...this.mapAttemptIds(runId)]);
          for (const attempt of this.latestAttempts(runId).filter(item => UNSTARTED.has(item.state) && !this.processes.get(item.id)?.launching && !loopAttempts.has(item.id)))
            events.push(...this.attemptTransition(attempt, 'canceled', 'Canceled by root Stop before it started.', null,
              { source: 'external_control', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'not_started', sideEffectCertainty: 'none_proven' }));
          this.cancelLoops(runId, events, 'Loop canceled by root Stop.');
          this.cancelMaps(runId, events, 'Map canceled by root Stop.');
          this.cancelManagedTasks(runId, events, 'Managed task canceled by root Stop.');
          this.store.appendEvents(runId, events);
        });
      } else {
        this.store.transaction(() => this.invalidateProtectedSelfRepairForStopInTransaction?.(runId, row.state));
      }
      return { status: 202, body: { runId, state: 'stopping', requestId: body.requestId } };
    }, () => {
      // The proof names every launched member, so termination is checked against what this Stop actually owned.
      if (shouldSignalProcesses) this.stopRequests.set(runId, { requestedAt: nowIso(), observed: true,
        pids: [...this.processes.entries()].filter(([, record]) => record.runId === runId && record.launched && record.child?.pid).map(([attemptId, record]) => ({ attemptId, pid: record.child.pid, custodyId: record.child.custody ? record.child.custodyId ?? null : null })) });
      if (shouldSignalProcesses) for (const record of this.processes.values()) if (record.runId === runId) {
        record.stopRequested = true;
        record.stopSource = 'external_control';
        record.stopReason = 'Stopped by root Stop.';
        record.abortController?.abort();
        if (record.launched) this.terminateLaunched(record.child);
      }
      this.afterLogicalParentStop(runId);
      queueMicrotask(() => this.pump());
    });
  }

  stopNode(runId, instanceId, body) {
    this.validateBody('nodeStopRequest', body);
    let loopToStop = null;
    let processToStop = null;
    let taskToStop = null;
    return this.idempotent(`POST /runs/${runId}/nodes/${instanceId}/stop`, body.requestId, body, () => {
      const row = this.requireRun(runId);
      const state = this.runs.get(runId);
      if (!state || !['running', 'draining'].includes(row.state)) throw new ApiError(409, 'conflict', `The run is ${row.state}; a scoped Stop needs a running run.`);
      const attempt = this.latestAttempt(runId, instanceId);
      if (!attempt) throw new ApiError(404, 'not_found', `Node instance "${instanceId}" does not exist in this run.`);
      const loop = this.loopRow(state, instanceId);
      const task = this.store.get("SELECT id FROM managed_tasks WHERE run_id=? AND node_instance_id=? AND state IN ('running','paused')", runId, instanceId);
      if (task) {
        taskToStop = { state, instanceId };
      } else if (loop) {
        if (loop.state !== 'running') throw new ApiError(409, 'conflict', `Loop "${instanceId}" is ${loop.state}.`);
        loopToStop = { state, instanceId };
      } else {
        // A held P5 capture is live under its hold key, not the Attempt id (review recheck 4a).
        const record = this.processes.get(attempt.id)
          ?? [...this.processes.values()].find(item => item.p5CaptureHold && item.attemptId === attempt.id);
        if (!record || attempt.state !== 'running') throw new ApiError(409, 'conflict', `"${instanceId}" is not running.`);
        processToStop = record;
      }
      return { status: 202, body: { runId, state: row.state, requestId: body.requestId } };
    }, () => {
      if (taskToStop) {
        this.store.transaction(() => {
          const events = [];
          this.cancelManagedTasks(runId, events, 'Managed task canceled by scoped Stop.', instanceId);
          if (events.length) this.store.appendEvents(runId, events);
        });
        for (const record of this.processes.values()) if (record.taskExecutionId === this.store.get('SELECT id FROM managed_tasks WHERE run_id=? AND node_instance_id=? ORDER BY created_at DESC LIMIT 1', runId, instanceId)?.id) {
          if (record.launched) this.terminateLaunched(record.child);
        }
        queueMicrotask(() => this.pump());
      } else if (loopToStop) {
        this.loopRuntime(loopToStop.state, loopToStop.instanceId).pending = ['stopped', 'Stopped by the user.'];
        this.stopLoopBody(loopToStop.state, loopToStop.instanceId, 'external_control');
      } else if (processToStop) {
        processToStop.stopRequested = true;
        processToStop.stopSource = 'external_control';
        processToStop.stopReason = 'Stopped by the user (scoped Stop).';
        processToStop.abortController?.abort();
        if (processToStop.parentAttemptId) {
          const parent = this.processes.get(processToStop.parentAttemptId);
          if (parent) { parent.stopRequested = true; parent.abortController?.abort(); }
        }
        if (processToStop.launched) this.terminateLaunched(processToStop.child);
        queueMicrotask(() => this.pump());
      }
    });
  }

  // ---------- Recovery ----------
  recoverRun(runId, body) {
    if (this.judgeAttentionEnabled && this.hasJudgeBarrier(runId) && body?.action !== 'close') throw new ApiError(409,'judge_attention_pending','An independent Judge attention barrier blocks recovery. Stop or explicitly close remains available.');
    this.validateBody('recoveryRequest', body);
    return this.idempotent(`POST /runs/${runId}/recovery`, body.requestId, body, () => {
      const row = this.requireRun(runId);
      const capturedWorkflow = this.store.readJson(row.workflow_snapshot_artifact_id);
      if (body.action !== 'close' && capturedWorkflow.judgePolicy
        && this.workflowJudgeHasBarrier(runId))
        throw new ApiError(409, 'judge_attention_pending', 'Native P4 attention or its typed human question must be resolved through the designated Judge before manual recovery. Stop or explicit close remains available.');
      const state = this.runs.get(runId);
      if (row.state !== 'waiting_for_user' || !state) throw new ApiError(409, 'conflict', `Recovery needs a run that is waiting for the user (state is ${row.state}).`);
      const logicalParentLink = this.logicalRepairLinkForRun?.(runId);
      if (body.action !== 'close' && logicalParentLink?.parent_run_id === runId && logicalParentLink.parent_suspension_state !== 'resumed')
        throw new ApiError(409, 'parent_repair_pending', 'The Parent is held by its durable Repair coordination; only that coordinator may resume or retry its checkpoint.');
      if (body.action !== 'close') {
        const link = this.openLinkOfRepair(runId);
        const isolationIssue = link ? this.linkedRepairWorkspaceIssueForLink(link) : null;
        if (isolationIssue) throw new ApiError(409, isolationIssue.code, isolationIssue.message);
      }
      const target = body.nodeInstanceId ?? body.loopNodeId ?? null;
      const options = Object.fromEntries(Object.entries(body).filter(([key]) => !['requestId', 'action', 'nodeInstanceId', 'loopNodeId'].includes(key)));
      return this.store.transaction(() => {
        const events = [{ type: 'run.recovery_requested', payload: { action: body.action, target, requestId: body.requestId, options } }];
        if (body.action === 'close') {
          this.workflowJudgeSupersedeAttentionInTransaction(runId, 'Owner closed the Run.', events);
          this.workflowJudgeSupersedeQuestionsInTransaction(runId, 'Owner closed the Run.', events);
          const loopAttempts = new Set([...this.store.all('SELECT attempt_id FROM loop_executions WHERE run_id = ?', runId).map(item => item.attempt_id), ...this.mapAttemptIds(runId)]);
          for (const attempt of this.latestAttempts(runId).filter(item => UNSTARTED.has(item.state) && !loopAttempts.has(item.id)))
            events.push(...this.attemptTransition(attempt, 'canceled', 'Closed by the user.', null,
              { source: 'external_control', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'not_started', sideEffectCertainty: 'none_proven' }));
          this.cancelLoops(runId, events, 'Loop canceled when the run was closed.');
          this.cancelMaps(runId, events, 'Map canceled when the run was closed.');
          this.cancelManagedTasks(runId, events, 'Managed task canceled when the run was closed.');
          events.push(this.runEvent(row, 'failed', 'Closed by the user after a failure or pause.'));
          this.store.appendEvents(runId, events);
          // ADR-0008: closing a linked repair is a terminal failure of the repair; its parent must not resume.
          this.recordRepairOutcome(runId, 'failed');
          this.forget(state);
          return { status: 200, body: { runId, state: 'failed', requestId: body.requestId } };
        }
        if (body.action === 'retry' && this.isManagedTaskStep(state, body.nodeInstanceId)) this.retryManagedTaskStep(state, body, events);
        else if (body.action === 'retry' && this.isMapStep(state, body.nodeInstanceId)) this.retryMapStep(state, body, events);
        else if (body.action === 'retry') this.retry(state, body, events);
        else if (body.action === 'raise-map-limit') this.raiseMapLimit(state, body, events);
        else if (body.action === 'raise-limit') this.raiseLimit(state, body, events);
        else this.restartIteration(state, body, events);
        events.push(this.runEvent(row, 'running', `Recovery: ${body.action}.`));
        this.store.appendEvents(runId, events);
        return { status: 202, body: { runId, state: 'running', requestId: body.requestId } };
      });
    }, () => {
      if (body.action === 'close') this.afterLogicalParentClose(runId);
      queueMicrotask(() => this.pump());
    });
  }

  retry(state, body, events) {
    // P4 manual recovery barriers are enforced at the public recovery command; P2 continuation remains the only retry authority.
    this.assertWorkflowJudgeRuntimeAvailable(state.workflow);
    const attempt = this.latestAttempt(state.id, body.nodeInstanceId);
    if (!attempt) throw new ApiError(404, 'not_found', `Node instance "${body.nodeInstanceId}" does not exist in this run.`);
    if (!['failed', 'canceled'].includes(attempt.state)) throw new ApiError(409, 'conflict', `Only failed or canceled attempts can be retried (state is ${attempt.state}).`);
    if (this.loopRow(state, body.nodeInstanceId)) throw new ApiError(409, 'conflict', 'A started loop is recovered through raise-limit, restart-iteration or its body nodes.');
    const located = this.locate(state, body.nodeInstanceId);
    const { loopInstance, iteration } = parseInstance(body.nodeInstanceId);
    if (loopInstance) {
      const loop = this.loopRow(state, loopInstance);
      if (loop.iteration !== iteration) throw new ApiError(409, 'conflict', `Iteration ${iteration} is not the loop's current iteration.`);
      if (loop.state === 'paused' && ['iteration_limit', 'time_limit'].includes(loop.pause_reason)) throw new ApiError(409, 'conflict', `The loop is paused at its ${loop.pause_reason.replace('_', ' ')}; raise the limit first.`);
    }
    const node = located.node;
    if (node.type === 'task' && this.store.get('SELECT 1 FROM managed_tasks WHERE run_id=? AND node_instance_id=?', state.id, body.nodeInstanceId)) throw new ApiError(409, 'conflict', 'Recover the current managed task step; retrying its parent would reset aggregate accounting. After cancellation, start a newly captured run.');
    if (node.type === 'agent' && node.config.contextId) {
      const key = this.contextKey(state, located.scope, node.config.contextId);
      const mapping = this.store.get('SELECT * FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, key);
      const binding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', mapping.binding_id);
      const choice = body.binding || 'keep';
      if (choice === 'keep' && !['ready', 'unbound'].includes(binding.state)) throw new ApiError(422, 'context_unavailable', `The Context binding is ${binding.state}; retry with binding "acknowledge" or "fresh".`);
      if (choice === 'acknowledge' && binding.state === 'needs_review')
        events.push(this.bindingTransition(binding, this.bindingRecord(binding).nativeSessionId ? 'ready' : 'unbound', 'Accepted by the user for retry.', { acknowledgedAt: nowIso() })[0]);
      else if (choice === 'acknowledge' && !['ready', 'unbound'].includes(binding.state)) throw new ApiError(422, 'context_unavailable', `A ${binding.state} binding cannot be acknowledged.`);
      if (choice === 'fresh') {
        if (mapping.mode !== 'new') throw new ApiError(422, 'context_unavailable', 'A Continue Context cannot switch to a fresh binding; edit the workflow instead.');
        const fresh = this.createBinding(state.id, this.workspaceOf(state), binding.provider, key);
        this.store.run('UPDATE run_context_bindings SET binding_id = ? WHERE run_id = ? AND context_node_id = ?', fresh, state.id, key);
        events.push({ type: 'context.remapped', payload: { contextNodeId: key, fromBindingId: binding.id, toBindingId: fresh, reason: 'Fresh binding selected for retry.' } });
      }
    } else if (body.binding) throw new ApiError(409, 'conflict', 'binding applies only to Agents that use a Context.');
    // The reason is internal: the HTTP recovery schema forbids extra fields, so only an Engine continuation sets it.
    this.planAttempt(state, body.nodeInstanceId, node.id, node.type, loopInstance ? { loopNodeId: loopInstance, iteration } : null, events, body.reason || 'Retry requested by the user.');
    if (loopInstance && this.loopRow(state, loopInstance).state === 'paused') this.resumeLoop(state, loopInstance, 'A body node was retried.', events);
  }

  raiseLimit(state, body, events) {
    const loop = this.loopRow(state, body.loopNodeId);
    if (!loop) throw new ApiError(404, 'not_found', `Loop "${body.loopNodeId}" has not started in this run.`);
    if (loop.state !== 'paused' || !['iteration_limit', 'time_limit'].includes(loop.pause_reason)) throw new ApiError(409, 'conflict', 'raise-limit needs a loop paused at its iteration or time limit.');
    if (body.maxIterations < loop.max_iterations || body.maxActiveMinutes < loop.max_active_minutes) throw new ApiError(409, 'conflict', 'Limits can only be raised.');
    if (loop.pause_reason === 'iteration_limit' && body.maxIterations <= loop.iteration) throw new ApiError(409, 'conflict', `maxIterations must exceed the completed iteration ${loop.iteration}.`);
    if (loop.pause_reason === 'time_limit' && body.maxActiveMinutes * this.loopMinuteMs <= loop.active_ms) throw new ApiError(409, 'conflict', 'maxActiveMinutes must exceed the active time already used.');
    this.store.run('UPDATE loop_executions SET max_iterations = ?, max_active_minutes = ? WHERE run_id = ? AND loop_node_id = ?', body.maxIterations, body.maxActiveMinutes, state.id, body.loopNodeId);
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', loop.attempt_id);
    events.push({ type: 'loop.limits_changed', nodeInstanceId: body.loopNodeId, attemptId: loopAttempt.id, payload: { loopNodeId: body.loopNodeId, maxIterations: body.maxIterations, maxActiveMinutes: body.maxActiveMinutes } });
    const reason = loop.pause_reason;
    this.resumeLoop(state, body.loopNodeId, 'Limits raised.', events);
    if (reason === 'iteration_limit') {
      const last = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, body.loopNodeId, loop.iteration);
      this.store.run(`UPDATE loop_iterations SET outcome = 'continued' WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`, state.id, body.loopNodeId, loop.iteration);
      const decision = this.store.readJson(parseStrictJson(last.decision_json).artifact.artifactId);
      this.startIteration(state, body.loopNodeId, loopAttempt, loop.iteration + 1, parseStrictJson(last.candidate_json), textValue(this.store.putText(decision.feedback)), events, false);
    } else {
      const prefix = bodyPrefix(body.loopNodeId, loop.iteration);
      for (const attempt of this.latestAttempts(state.id).filter(item => item.node_instance_id.startsWith(prefix) && item.state === 'canceled' && !this.isMapStep(state, item.node_instance_id))) {
        const node = this.locate(state, attempt.node_instance_id).node;
        this.planAttempt(state, attempt.node_instance_id, node.id, node.type, { loopNodeId: body.loopNodeId, iteration: loop.iteration }, events, 'Re-planned after the time limit was raised.');
      }
    }
  }

  restartIteration(state, body, events) {
    const loop = this.loopRow(state, body.loopNodeId);
    if (!loop) throw new ApiError(404, 'not_found', `Loop "${body.loopNodeId}" has not started in this run.`);
    if (loop.state !== 'paused') throw new ApiError(409, 'conflict', 'restart-iteration needs a paused loop.');
    if (loop.pause_reason === 'time_limit') throw new ApiError(409, 'conflict', 'The loop is out of active time; raise the limit first.');
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', loop.attempt_id);
    const iteration = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, body.loopNodeId, loop.iteration);
    this.resumeLoop(state, body.loopNodeId, 'Iteration restarted.', events);
    this.startIteration(state, body.loopNodeId, loopAttempt, loop.iteration, parseStrictJson(iteration.value_json), parseStrictJson(iteration.feedback_json), events, true);
  }

  readArtifact(artifactId) {
    const { bytes, row } = this.store.readBytes(artifactId);
    return { bytes, mediaType: row.media_type, sha256: row.sha256 };
  }

  async shutdown() {
    this.closing = true;
    this.stopCustodyHoldReconciler();
    if (this.unconfirmedWatch) clearInterval(this.unconfirmedWatch);
    this.unconfirmedWatch = null;
    const live = [...this.processes.values()];
    // A Host-owned CLI outlives this Engine: it is detached, never stopped, and its exit is not awaited here. The next attached
    // Engine resumes it from the Host's record.
    for (const record of live) {
      record.stopRequested = true; record.runtimeShutdown = true; record.abortController?.abort();
      // The Host enforces the admitted deadline of a Host-owned CLI: the Engine's own timeout must not keep this Engine alive after detaching.
      if (record.child?.custody) { clearTimeout(record.timer); record.child.detach(); continue; }
      if (record.launched) await this.terminateLaunched(record.child);
    }
    await Promise.all(live.filter(record => !record.child?.custody).map(record => record.exited).filter(Boolean));
    for (const state of this.runs.values()) for (const loop of state.loops.values()) clearInterval(loop.timer);
    await new Promise(done => setTimeout(done, 50));
    if (this.runtimeHeartbeat) clearInterval(this.runtimeHeartbeat);
    this.store.close();
  }
}

installMapRuntime(Engine, { ApiError, UNSTARTED });
installSupervision(Engine, { ApiError });
installHostAutonomy(Engine, { ApiError });
installTaskRuntime(Engine, { ApiError });
installTaskProcesses(Engine);
installLinkedRepair(Engine, { ApiError });
installWorkflowJudge(Engine, { ApiError });
installJudgeAttention(Engine, { ApiError });
installCustody(Engine);
installProtectedSelfRepairGate(Engine);

