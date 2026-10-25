import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canonicalBytes, canonicalHash, sha256 } from './canonical.mjs';
import { assertValid, ContractError } from './schemas.mjs';
import { isAlive, killTree, launch } from './processes.mjs';
import { nowIso } from './store.mjs';
import { ref } from './utilities.mjs';
import clientTimeouts from '../../docs/authoring/client-timeouts.json' with { type: 'json' };

// Observation, supervision, incidents and audit (ADR-0002). The runtime remains the source of execution facts;
// the native supervisor, when present, enforces containment and the escalation deadline independently.
export const MAX_WATCH_WAIT_MS = 20_000; // Provisional until client timeouts are measured; clamps every watch_run wait.
export const WATCH_EVENT_LIMIT = 200;
export const WATCH_BYTE_LIMIT = 256 * 1024;
export const RANGE_BYTE_LIMIT = 64 * 1024;
export const WATCHDOG_TICK_MS = 1000;
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const ACTIVE = new Set(['queued', 'running', 'draining', 'waiting_for_user', 'stopping']);

const uuidOf = hex => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
// Deterministic identifiers so a retried request reconciles with the same stop and incident instead of duplicating them.
export const derivedUuid = (requestId, label) => uuidOf(sha256(Buffer.from(`${requestId}:${label}`, 'utf8')).slice(0, 32));

function collectRefs(value, refs) {
  if (Array.isArray(value)) for (const item of value) collectRefs(item, refs);
  else if (value && typeof value === 'object') {
    if (typeof value.artifactId === 'string' && typeof value.sha256 === 'string') refs.set(value.artifactId, value.sha256);
    for (const item of Object.values(value)) collectRefs(item, refs);
  }
}

// Artifact rows name their identity `id`; journal and record references name it `artifactId`.
const referenceOf = row => ({ artifactId: row.id, sha256: row.sha256 });

// Streams a file through SHA-256 so hashing never holds a large object in memory or blocks the event loop.
async function digestOfFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const yieldToEventLoop = () => new Promise(done => setImmediate(done));

function clientStatus(provider) {
  return clientTimeouts.entries.find(entry => entry.provider === provider) ?? { provider, status: 'unverified' };
}

export function installSupervision(Engine, { ApiError }) {
  const P = Engine.prototype;
  const contract = (definition, body) => {
    try { assertValid('run-control-api.schema.json', definition, body, `Request for ${definition}`); }
    catch (error) { if (error instanceof ContractError) throw new ApiError(400, 'invalid_request', `Request does not match ${definition}.`, error.details); throw error; }
  };
  const incidentContract = observation => {
    try { assertValid('incident.schema.json', 'incidentObservation', observation, 'Incident observation'); }
    catch (error) { if (error instanceof ContractError) throw new ApiError(400, 'invalid_request', 'Incident observation does not match its contract.', error.details); throw error; }
  };

  // ---------- Control state ----------
  P.activeGrant = function activeGrant(runId) {
    return this.store.get("SELECT * FROM control_grants WHERE run_id = ? AND state = 'active'", runId) ?? null;
  };

  P.boundGrant = function boundGrant(runId) {
    return this.activeGrant(runId) ?? this.store.get('SELECT * FROM control_grants WHERE run_id = ? ORDER BY bound_at DESC LIMIT 1', runId) ?? null;
  };

  P.controlModeOf = function controlModeOf(runId) {
    // Execution mode is historical: ending/revoking a bound grant cannot rewrite a captured run or its proof.
    return this.store.get('SELECT 1 FROM control_grants WHERE run_id = ? LIMIT 1', runId) ? 'supervised' : 'unsupervised';
  };

  P.controllerHealth = function controllerHealth(runId) {
    const grant = this.boundGrant(runId);
    if (!grant) return null;
    const since = grant.last_ack_at ?? grant.bound_at;
    return { grantId: grant.id, controllerSessionId: grant.controller_session_id, state: grant.state, boundAt: grant.bound_at,
      ackCursor: grant.ack_cursor, lastAckAt: grant.last_ack_at, pausedAt: grant.paused_at,
      observationDeadlineMs: grant.observation_deadline_ms, escalationDeadlineMs: grant.escalation_deadline_ms,
      millisecondsSinceAcknowledgement: since ? Date.now() - Date.parse(since) : null };
  };

  // ---------- Controller sessions and grants ----------
  // A session carries a credential: the runtime stores only its hash, and the token is returned once, on creation.
  // A replayed request returns the session without the token, because the token is never written to the store.
  P.createControllerSession = function createControllerSession(body) {
    contract('controllerSessionRequest', body);
    let issued = null;
    const result = this.idempotent('POST /controller-sessions', body.requestId, body, () => {
      const id = randomUUID(), at = nowIso();
      const token = randomBytes(32).toString('base64url');
      issued = token;
      this.store.run('INSERT INTO controller_sessions(id, client_label, token_sha256, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        id, body.clientLabel, sha256(Buffer.from(token, 'utf8')), at, at);
      return { status: 201, body: { controllerSessionId: id, clientLabel: body.clientLabel, clientProvider: body.clientProvider, createdAt: at } };
    });
    return issued ? { status: result.status, body: { ...result.body, controllerToken: issued } } : result;
  };

  P.controllerSessionFor = function controllerSessionFor(token) {
    if (typeof token !== 'string' || !token) return null;
    return this.store.get('SELECT id FROM controller_sessions WHERE token_sha256 = ?', sha256(Buffer.from(token, 'utf8'))) ?? null;
  };

  // Acts for a session only with the credential issued to it. The external token alone never does.
  P.requireControllerCredential = function requireControllerCredential(token, sessionId) {
    const session = this.controllerSessionFor(token);
    if (!session || session.id !== sessionId) throw new ApiError(403, 'controller_credential_required', 'This command needs the controller credential issued to its session.');
    return session.id;
  };

  // A grant is refused, typed, unless the runtime has a supervisor and the client's timeout matrix is verified.
  // The grant pins the exact workflow revision the user approves: a later revision cannot start under it.
  P.requestControlGrant = function requestControlGrant(body, { controllerToken = null } = {}) {
    contract('controlGrantRequest', body);
    if (body.escalationDeadlineMs <= body.observationDeadlineMs) throw new ApiError(400, 'invalid_request', 'The escalation deadline must be longer than the observation deadline.');
    return this.idempotent('POST /control-grants', body.requestId, body, () => {
      if (!this.supervisor) throw new ApiError(409, 'supervision_unavailable', 'This runtime has no Tauri supervisor, so it cannot grant supervision. Ordinary runs stay unsupervised and report controlMode "unsupervised".');
      const client = clientStatus(body.clientProvider);
      if (client.status !== 'verified') throw new ApiError(409, 'supervision_unavailable', `The ${body.clientProvider} tool-timeout matrix is unverified, so supervised observation cannot be guaranteed for this client.`);
      if (client.testedVersion && body.clientVersion !== client.testedVersion) throw new ApiError(409, 'supervision_unavailable', 'The controller version does not match the measured tool-timeout matrix.');
      if (!this.store.get('SELECT id FROM controller_sessions WHERE id = ?', body.controllerSessionId)) throw new ApiError(404, 'not_found', 'Controller session not found.');
      this.requireControllerCredential(controllerToken, body.controllerSessionId);
      if (!this.store.get('SELECT id FROM workflows WHERE id = ?', body.workflowId)) throw new ApiError(404, 'not_found', 'Workflow not found.');
      // A grant names a definition that can run, so it must match an exact Runnable Published Version. The mutable Draft
      // pointer is not an execution identity: an unpublished edit neither grants nor revokes supervision of a published version.
      if (!this.store.get(`SELECT p.id FROM workflow_publications p JOIN artifacts a ON a.id = p.snapshot_artifact_id
        WHERE p.workflow_id = ? AND a.sha256 = ? AND p.runnable = 1 LIMIT 1`, body.workflowId, body.workflowSnapshotSha256))
        throw new ApiError(409, 'conflict', 'The supervised definition is not a Runnable Published Version of this workflow; publish it before requesting supervision.');
      if (!this.store.get('SELECT id FROM workspaces WHERE id = ?', body.workspaceId)) throw new ApiError(404, 'not_found', 'Workspace not found.');
      const grant = { schemaVersion: 1, kind: 'ControlGrant', controllerSessionId: body.controllerSessionId, workflowId: body.workflowId, workflowSnapshotSha256: body.workflowSnapshotSha256,
        workspaceId: body.workspaceId, clientProvider: body.clientProvider, clientVersion: body.clientVersion ?? null, requestedActions: body.requestedActions,
        observationDeadlineMs: body.observationDeadlineMs, escalationDeadlineMs: body.escalationDeadlineMs };
      contract('controlGrantRecord', grant);
      const artifact = this.store.putJson(grant);
      const id = randomUUID();
      this.store.run(`INSERT INTO control_grants(id, controller_session_id, workflow_id, workspace_id, workflow_snapshot_sha256, run_id, state, grant_artifact_id, observation_deadline_ms, escalation_deadline_ms, requested_at)
        VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?)`, id, body.controllerSessionId, body.workflowId, body.workspaceId, body.workflowSnapshotSha256, artifact.artifactId, body.observationDeadlineMs, body.escalationDeadlineMs, nowIso());
      return { status: 202, body: { grantId: id, state: 'pending', workflowId: body.workflowId, workspaceId: body.workspaceId, observationDeadlineMs: body.observationDeadlineMs, escalationDeadlineMs: body.escalationDeadlineMs } };
    });
  };

  // Public Owner Token authority makes the grant available to one new run.
  P.decideControlGrant = function decideControlGrant(grantId, body, { hostAdmission = null } = {}) {
    contract('controlGrantDecision', body);
    return this.idempotent(`POST /control-grants/${grantId}/decision`, body.requestId, { grantId, ...body }, () => {
      const grant = this.grantRow(grantId);
      if (grant.state !== 'pending') throw new ApiError(409, 'conflict', `The grant is ${grant.state}; only a pending grant can be decided.`);
      const state = body.decision === 'approve' ? 'approved' : 'denied';
      this.store.run('UPDATE control_grants SET state = ?, decided_at = ? WHERE id = ?', state, nowIso(), grantId);
      return { status: 200, body: { grantId, state } };
    });
  };

  P.grantRow = function grantRow(grantId) {
    const grant = this.store.get('SELECT * FROM control_grants WHERE id = ?', grantId);
    if (!grant) throw new ApiError(404, 'not_found', 'Control grant not found.');
    return grant;
  };

  P.getControlGrant = function getControlGrant(grantId) {
    const grant = this.grantRow(grantId);
    const record = this.store.readJson(grant.grant_artifact_id);
    const session = this.store.get('SELECT client_label FROM controller_sessions WHERE id = ?', grant.controller_session_id);
    return { grantId, state: grant.state, runId: grant.run_id, workflowId: grant.workflow_id, workspaceId: grant.workspace_id, controllerSessionId: grant.controller_session_id,
      workflowSnapshotSha256: grant.workflow_snapshot_sha256, clientLabel: session?.client_label ?? null,
      clientProvider: record.clientProvider, clientVersion: record.clientVersion, requestedActions: record.requestedActions,
      observationDeadlineMs: grant.observation_deadline_ms, escalationDeadlineMs: grant.escalation_deadline_ms, requestedAt: grant.requested_at, decidedAt: grant.decided_at, boundAt: grant.bound_at };
  };

  P.listControlGrants = function listControlGrants({state = 'pending', limit = 50} = {}) {
    if (!['pending', 'approved', 'active', 'denied', 'revoked', 'ended', 'all'].includes(state) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(400, 'invalid_request', 'Invalid control-grant list state or limit.');
    const rows = state === 'all' ? this.store.all('SELECT id FROM control_grants ORDER BY requested_at DESC LIMIT ?', limit)
      : this.store.all('SELECT id FROM control_grants WHERE state = ? ORDER BY requested_at DESC LIMIT ?', state, limit);
    return {items: rows.map(row => this.getControlGrant(row.id)), nextCursor: null};
  };

  P.assertControlGrantForRun = function assertControlGrantForRun(grantId, {workflowId, workspaceId, snapshotSha256, controllerToken = null, approvedRequestId = null}) {
    const grant = this.grantRow(grantId);
    if (grant.state !== 'approved') throw new ApiError(409, 'conflict', `The control grant is ${grant.state}; only an approved, unused grant can start a supervised run.`);
    if (grant.workflow_id !== workflowId || grant.workspace_id !== workspaceId || grant.workflow_snapshot_sha256 !== snapshotSha256)
      throw new ApiError(409, 'conflict', 'The control grant does not match this workflow snapshot and workspace.');
    if (approvedRequestId) {
      const proof = this.store.get('SELECT c.*, r.state FROM run_request_controls c JOIN external_run_requests r ON r.request_id = c.request_id WHERE c.request_id = ?', approvedRequestId);
      if (!proof || proof.state !== 'pending' || proof.grant_id !== grantId || proof.controller_session_id !== grant.controller_session_id)
        throw new ApiError(403, 'controller_credential_required', 'The pending run has no matching authenticated controller binding.');
    } else this.requireControllerCredential(controllerToken, grant.controller_session_id);
    if (!this.supervisor) throw new ApiError(409, 'supervision_unavailable', 'This runtime has no Tauri supervisor, so it cannot start a supervised run.');
    return grant;
  };

  // Called inside createRun, before the run's first dispatch: the observer is armed before any launch.
  P.bindControlGrant = function bindControlGrant(grantId, { runId, workflowId, workspaceId, snapshotSha256, controllerToken = null, approvedRequestId = null }) {
    const grant = this.assertControlGrantForRun(grantId, {workflowId, workspaceId, snapshotSha256, controllerToken, approvedRequestId});
    // The only arm is the awaited one below; a refusal reaches failArm instead of an unhandled rejection.
    const at = nowIso();
    // The run may not launch anything until the supervisor confirms the arm (pumpRun honours awaitingArm).
    this.store.run("UPDATE control_grants SET state = 'active', run_id = ?, bound_at = ?, last_ack_at = NULL, ack_cursor = 0 WHERE id = ?", runId, at, grantId);
    const artifact = referenceOf(this.store.artifactRow(grant.grant_artifact_id));
    this.store.appendEvents(runId, [{ type: 'run.control_grant_changed', payload: { grant: artifact, state: 'active' } }]);
    this.awaitingArm.add(runId);
    Promise.resolve().then(() => this.supervisor.armRun(runId, { grantId, observationDeadlineMs: grant.observation_deadline_ms, escalationDeadlineMs: grant.escalation_deadline_ms })).then(result => {
      // The emergency credential lives only in this runtime's memory, and only for the run it was issued for.
      if (typeof result?.emergencyToken === 'string') this.emergencyCredentials.set(runId, result.emergencyToken);
      this.awaitingArm.delete(runId);
      this.startWatchdog(grantId, runId);
      this.pump();
    }, error => this.failArm(grantId, runId, error));
    return { grantId, controlMode: 'supervised', armed: 'pending' };
  };

  // A grant whose observer cannot be armed is revoked and its run stopped: nothing launches unsupervised under it.
  P.failArm = function failArm(grantId, runId, error) {
    this.awaitingArm.delete(runId);
    this.store.transaction(() => {
      this.store.run("UPDATE control_grants SET state = 'revoked' WHERE id = ?", grantId);
      const artifact = referenceOf(this.store.artifactRow(this.grantRow(grantId).grant_artifact_id));
      this.store.appendEvents(runId, [{ type: 'run.control_grant_changed', payload: { grant: artifact, state: 'revoked' } }]);
    });
    try { this.stopRun(runId, { requestId: derivedUuid(grantId, 'arm-failed-stop') }); }
    catch { /* The run may already be terminal; the revoked grant is the durable record. */ }
    process.stderr.write(`Supervision could not arm run ${runId}: ${error?.message ?? error}\n`);
  };

  P.revokeControlGrant = function revokeControlGrant(grantId, body) {
    contract('controlGrantRevoke', body);
    return this.idempotent(`POST /control-grants/${grantId}/revoke`, body.requestId, { grantId, ...body }, () => {
      const grant = this.grantRow(grantId);
      if (!['pending', 'approved', 'active'].includes(grant.state)) throw new ApiError(409, 'conflict', `The grant is ${grant.state}.`);
      if (grant.state !== 'active') {
        this.store.run("UPDATE control_grants SET state = 'revoked', decided_at = ? WHERE id = ?", nowIso(), grantId);
        return { status: 200, body: { grantId, state: 'revoked' } };
      }
      // Grant revocation stops the run immediately (ADR-0002 section 2).
      this.store.run("UPDATE control_grants SET state = 'revoked' WHERE id = ?", grantId);
      return { status: 202, body: { grantId, state: 'revoked', runId: grant.run_id, stopRequested: true } };
    }, () => {
      const grant = this.store.get('SELECT * FROM control_grants WHERE id = ?', grantId);
      if (grant?.state !== 'revoked' || !grant.run_id) return;
      if (ACTIVE.has(this.store.get('SELECT state FROM runs WHERE id = ?', grant.run_id).state)) this.stopRun(grant.run_id, { requestId: derivedUuid(body.requestId, 'revoke-stop') });
      this.stopWatchdog(grant.run_id);
      this.dispatchPaused.delete(grant.run_id);
      void Promise.resolve().then(() => this.supervisor?.disarmRun?.(grant.run_id)).catch(() => { /* The supervisor reports its own release. */ });
    });
  };

  // Ends supervision when its run reaches a terminal state, releasing the native deadline.
  P.endControl = function endControl(runId) {
    this.stopWatchdog(runId);
    this.emergencyCredentials.delete(runId);
    const grant = this.activeGrant(runId);
    this.dispatchPaused.delete(runId);
    if (!grant) return;
    this.store.run("UPDATE control_grants SET state = 'ended' WHERE id = ?", grant.id);
    void Promise.resolve().then(() => this.supervisor?.disarmRun?.(runId)).catch(() => { /* The supervisor reports its own release. */ });
    // A run that ended without a Stop has no members to prove; release its Job when the supervisor agrees it is empty.
    if (!this.stopRequests.has(runId)) void Promise.resolve().then(() => this.supervisor?.releaseRun?.(runId)).catch(() => {});
  };

  // Public Owner Token authority may request a deadline extension. The supervisor confirms the new deadline before the runtime reports success, and the
  // extension is journaled with its request so a retry replays the same answer.
  P.extendEscalation = async function extendEscalation(runId, body) {
    contract('controlExtensionRequest', body);
    const replay = this.store.get('SELECT response_artifact_id FROM command_receipts WHERE request_id = ?', body.requestId);
    if (replay) return { status: 200, body: this.store.readJson(replay.response_artifact_id) };
    const grant = this.activeGrant(runId);
    if (!grant) throw new ApiError(409, 'conflict', 'The run has no active supervision grant to extend.');
    if (!this.supervisor?.extendRun) throw new ApiError(409, 'supervision_unavailable', 'This runtime has no supervisor to extend.');
    let confirmed;
    try { confirmed = await this.supervisor.extendRun(runId, body.extensionMs); }
    catch (error) { throw new ApiError(409, 'supervision_unavailable', `The supervisor did not confirm the extension: ${error.message}`); }
    const response = { runId, grantId: grant.id, extensionMs: body.extensionMs, reason: body.reason, confirmed };
    const artifact = this.store.putJson(response);
    this.store.transaction(() => {
      this.store.run('INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at) VALUES (?, ?, ?, ?, ?)',
        body.requestId, `POST /runs/${runId}/control-extension`, sha256(canonicalBytes(body)), artifact.artifactId, nowIso());
      this.store.appendEvents(runId, [{ type: 'run.control_grant_changed', payload: { grant: referenceOf(this.store.artifactRow(grant.grant_artifact_id)), state: 'extended', extensionMs: body.extensionMs } }]);
    });
    return { status: 200, body: response };
  };

  // The granted controller obtains the emergency credential with its session credential. Nothing else can.
  P.emergencyCredential = function emergencyCredential(runId, controllerToken) {
    const grant = this.activeGrant(runId);
    if (!grant) throw new ApiError(409, 'conflict', 'The run has no active supervision grant.');
    this.requireControllerCredential(controllerToken, grant.controller_session_id);
    const emergencyToken = this.emergencyCredentials.get(runId);
    if (!emergencyToken || !this.supervisor) throw new ApiError(409, 'supervision_unavailable', 'The supervisor has not issued an emergency credential for this run.');
    return { runId, pipeName: this.supervisor.pipeName, emergencyToken };
  };

  P.getRunControl = function getRunControl(runId) {
    this.requireRun(runId);
    const proof = this.store.get('SELECT outcome FROM termination_proofs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', runId);
    return { runId, controlMode: this.controlModeOf(runId), dispatchPaused: this.dispatchPaused.has(runId), controller: this.controllerHealth(runId),
      terminationOutcome: proof?.outcome ?? null, supervisor: Boolean(this.supervisor) };
  };

  // ---------- Watchdog (runtime policy; the native supervisor enforces escalation) ----------
  P.startWatchdog = function startWatchdog(grantId, runId) {
    this.stopWatchdog(runId);
    const timer = setInterval(() => { this.watchdogTick(grantId, runId); void this.checkEscalation(runId); }, WATCHDOG_TICK_MS);
    timer.unref?.();
    this.watchdogs.set(runId, timer);
  };

  P.stopWatchdog = function stopWatchdog(runId) {
    const timer = this.watchdogs.get(runId);
    if (timer) clearInterval(timer);
    this.watchdogs.delete(runId);
  };

  // Missed acknowledgement pauses new dispatch and raises a controller_unresponsive incident. Existing work keeps its
  // own timeouts; escalation to a stop belongs to the supervisor's monotonic deadline.
  P.watchdogTick = function watchdogTick(grantId, runId) {
    const grant = this.store.get('SELECT * FROM control_grants WHERE id = ?', grantId);
    if (!grant || grant.state !== 'active') { this.stopWatchdog(runId); return; }
    const since = Date.now() - Date.parse(grant.last_ack_at ?? grant.bound_at);
    if (since <= grant.observation_deadline_ms || grant.paused_at) return;
    const at = nowIso();
    this.store.run('UPDATE control_grants SET paused_at = ? WHERE id = ?', at, grantId);
    this.dispatchPaused.add(runId);
    this.insertIncident({ schemaVersion: 1, kind: 'IncidentObservation', title: 'The controller did not acknowledge an observation', component: 'supervision',
      category: 'controller_unresponsive', severity: 'high', confidence: 'high', causeStatus: 'suspected', expected: 'The controller acknowledges each semantic observation within the observation deadline.',
      actual: `No acknowledgement for ${since} ms. New dispatch is paused; existing work keeps its own timeouts.`, reproduction: [],
      versions: { app: null, runtime: null, cli: null }, sourceRevision: null, runId, nodeInstanceId: null, attemptId: null, eventRange: null, artifacts: [],
      captureGaps: [], controllerCommandId: null, reporter: { authority: 'system', sessionId: grant.controller_session_id } }, { runId, id: randomUUID() });
  };

  // The native supervisor escalates on its own monotonic clock and kills the run Job. The runtime records that
  // escalation as a critical incident and stops the run, so the proof and the report describe the same event.
  P.checkEscalation = async function checkEscalation(runId) {
    if (!this.supervisor?.status || !this.activeGrant(runId)) return;
    let status;
    try { status = await this.supervisor.status(runId); } catch { return; }
    this.supervisorEscalations ??= new Set();
    if (!status?.escalated || this.supervisorEscalations.has(runId)) return;
    this.supervisorEscalations.add(runId);
    this.insertIncident({ schemaVersion: 1, kind: 'IncidentObservation', title: 'The supervisor stopped an unacknowledged run', component: 'supervision',
      category: 'controller_unresponsive', severity: 'critical', confidence: 'high', causeStatus: 'suspected', expected: 'The controller acknowledges observations before the escalation deadline, or a first-party user extends it.',
      actual: 'The escalation deadline passed without an acknowledgement or a first-party extension; the supervisor terminated the run Job.', reproduction: [],
      versions: { app: null, runtime: null, cli: null }, sourceRevision: null, runId, nodeInstanceId: null, attemptId: null, eventRange: null, artifacts: [],
      captureGaps: [], controllerCommandId: null, reporter: { authority: 'system', sessionId: null } }, { runId, id: randomUUID() });
    try { this.stopRun(runId, { requestId: derivedUuid(runId, 'escalation-stop') }); }
    catch { /* The run may already be terminal; the incident and the supervisor's record remain. */ }
  };

  // A supervised run is acknowledged only by the controller that holds its grant: an acknowledgement renews the watchdog.
  P.acknowledgeObservation = function acknowledgeObservation(runId, body, { controllerToken = null } = {}) {
    contract('observationAckRequest', body);
    return this.idempotent(`POST /runs/${runId}/observation-acks`, body.requestId, { runId, ...body }, () => {
      const row = this.requireRun(runId);
      if (body.cursor > row.last_sequence) throw new ApiError(400, 'invalid_request', `Cursor ${body.cursor} is beyond the journal (last sequence ${row.last_sequence}).`);
      const event = body.cursor ? this.store.get('SELECT timestamp FROM journal_events WHERE run_id = ? AND sequence = ?', runId, body.cursor) : null;
      const at = nowIso();
      const lagMs = event ? Date.parse(at) - Date.parse(event.timestamp) : null;
      const grant = this.boundGrant(runId);
      if (grant) this.requireControllerCredential(controllerToken, grant.controller_session_id);
      this.store.run('INSERT INTO observation_acks(id, run_id, controller_session_id, cursor, event_timestamp, acknowledged_at, lag_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        randomUUID(), runId, grant?.controller_session_id ?? null, body.cursor, event?.timestamp ?? null, at, lagMs);
      const active = grant?.state === 'active';
      const resumed = Boolean(active && grant.paused_at);
      if (grant) this.store.run('UPDATE control_grants SET last_ack_at = ?, ack_cursor = ?, paused_at = ? WHERE id = ?', at, Math.max(grant.ack_cursor, body.cursor), active ? null : grant.paused_at, grant.id);
      return { status: 200, body: { runId, cursor: body.cursor, acknowledgedAt: at, lagMs, controlMode: grant ? 'supervised' : 'unsupervised', resumedDispatch: resumed } };
    }, () => {
      if (this.activeGrant(runId)) {
        void Promise.resolve().then(() => this.supervisor?.heartbeat?.(runId)).catch(() => { /* A missed heartbeat is logged by the supervisor. */ });
        this.dispatchPaused.delete(runId);
        queueMicrotask(() => this.pump());
      }
    });
  };

  // ---------- Bounded observation ----------
  P.journalPage = function journalPage(runId, cursor) {
    const rows = this.store.all('SELECT sequence, envelope_json FROM journal_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?', runId, cursor, WATCH_EVENT_LIMIT + 1);
    const events = [];
    let bytes = 0, nextCursor = cursor, truncated = rows.length > WATCH_EVENT_LIMIT;
    for (const row of rows.slice(0, WATCH_EVENT_LIMIT)) {
      if (events.length && bytes + row.envelope_json.length > WATCH_BYTE_LIMIT) { truncated = true; break; }
      events.push(JSON.parse(row.envelope_json));
      bytes += row.envelope_json.length;
      nextCursor = row.sequence;
    }
    return { events, nextCursor, truncated };
  };

  // Returns on a meaningful event, a terminal state or the bounded wait. The wait is clamped to MAX_WATCH_WAIT_MS.
  P.watchRun = async function watchRun(runId, { cursor = 0, waitMs = 0 } = {}) {
    let row = this.requireRun(runId);
    const wait = Math.min(Math.max(0, waitMs), MAX_WATCH_WAIT_MS);
    let page = this.journalPage(runId, cursor);
    if (!page.events.length && wait > 0 && ACTIVE.has(row.state)) {
      await new Promise(done => {
        const onEvent = envelope => { if (envelope.runId === runId) finish(); };
        const finish = () => { clearTimeout(timer); this.store.off('event', onEvent); done(); };
        const timer = setTimeout(finish, wait);
        this.store.on('event', onEvent);
      });
      page = this.journalPage(runId, cursor);
      row = this.requireRun(runId);
    }
    const critical = this.store.get("SELECT COUNT(*) AS n FROM incidents WHERE run_id = ? AND severity = 'critical' AND state != 'closed'", runId).n;
    const terminal = TERMINAL.has(row.state);
    return { runId, state: row.state, controlMode: this.controlModeOf(runId), cursor, nextCursor: page.nextCursor, lastSequence: row.last_sequence,
      events: page.events, truncated: page.truncated, terminal, reason: page.events.length ? 'event' : terminal ? 'terminal' : 'timeout',
      maxWaitMs: MAX_WATCH_WAIT_MS, controller: this.controllerHealth(runId), criticalIncidents: critical, skippedRanges: [] };
  };

  // Byte-exact range reads of a captured artifact. Base64 keeps every boundary byte-safe; the full digest is the stored one.
  P.readArtifactRange = function readArtifactRange(artifactId, { offset = 0, length = RANGE_BYTE_LIMIT } = {}) {
    const artifact = this.store.artifactRow(artifactId);
    if (!artifact) throw new ApiError(404, 'not_found', 'Artifact not found.');
    const size = artifact.byte_size;
    if (offset > size) throw new ApiError(400, 'invalid_request', `Offset ${offset} is beyond the artifact (${size} bytes).`);
    const take = Math.min(length, RANGE_BYTE_LIMIT, size - offset);
    const buffer = Buffer.alloc(take);
    if (take) {
      const fd = openSync(join(this.store.storeDir, artifact.relative_path), 'r');
      try { readSync(fd, buffer, 0, take, offset); } finally { closeSync(fd); }
    }
    return { artifactId, sha256: artifact.sha256, byteSize: size, mediaType: artifact.media_type, offset, length: take, nextOffset: offset + take,
      eof: offset + take >= size, encoding: 'base64', data: buffer.toString('base64'), rangeSha256: sha256(buffer) };
  };

  P.runEvidence = function runEvidence(runId) {
    this.requireRun(runId);
    return this.store.all('SELECT id, attempt_id, outcome, evidence_artifact_id, created_at FROM execution_evidence WHERE run_id = ? ORDER BY created_at', runId)
      .map(row => ({ evidenceId: row.id, attemptId: row.attempt_id, outcome: row.outcome, evidence: referenceOf(this.store.artifactRow(row.evidence_artifact_id)), createdAt: row.created_at }));
  };

  P.runProcesses = function runProcesses(runId) {
    this.requireRun(runId);
    return [...this.processes.entries()].filter(([, record]) => record.runId === runId).map(([attemptId, record]) => ({
      attemptId, pid: record.child?.pid ?? null, launched: Boolean(record.launched), stopRequested: Boolean(record.stopRequested),
      alive: record.child?.pid ? isAlive(record.child.pid) : false }));
  };

  // Every process of a runtime under the Tauri supervisor launches through the native shim (ADR-0002 section 4). The shim
  // blocks until the supervisor duplicates the run's Job into it, so a failed binding kills it before any provider code runs.
  // Headless runs spawn directly; their Stop is reported as unconfirmed because nothing native proves termination.
  P.launchContained = function launchContained(runId, options) {
    if (!this.supervisor) return launch(options);
    if (!this.supervisor.shimPath) throw Object.assign(new Error('The launch shim is not available, so the process was not started; there is no direct-spawn fallback.'), { code: 'spawn_failed' });
    const rendezvousId = randomUUID();
    const child = launch({ ...options, command: this.supervisor.shimPath,
      args: ['--pipe', this.supervisor.pipeName, '--rendezvous', rendezvousId, '--', options.command, ...options.args] });
    Promise.resolve().then(() => this.supervisor.bindShim(runId, rendezvousId, child.pid)).catch(error => {
      process.stderr.write(`Launch shim binding failed for run ${runId}: ${error.message}\n`);
      if (child.pid) killTree(child.pid);
    });
    return child;
  };

  // ---------- Root Stop termination proof ----------
  P.recordTerminationProof = async function recordTerminationProof(runId) {
    const request = this.stopRequests.get(runId) ?? { requestedAt: nowIso(), pids: [], observed: false };
    this.stopRequests.delete(runId);
    // A Host-owned CLI is in the Host's own Job, not in the run Job: the run Job proves only the members it owns, and each Host-owned tree is
    // proven by its Host (processTreeEnded). A stop is recorded as stopped only when both proofs hold.
    // Every Host-owned invocation of the run counts, not only the ones this Stop snapshot saw: an invocation admitted or launched after the snapshot
    // is part of the run until its Host proves its tree ended.
    // Only invocations whose hold is still held: a hold released on the Host's proof has already been proven ended.
    const bound = this.store.all("SELECT b.attempt_id AS attemptId, b.custody_id AS custodyId FROM attempt_custody b JOIN custody_workspace_holds h ON h.custody_id = b.custody_id WHERE b.run_id = ? AND h.state = 'held'", runId);
    const boundOnly = bound.filter(item => !request.pids.some(pid => pid.attemptId === item.attemptId));
    const hostOwned = [...request.pids.filter(item => item.custodyId), ...boundOnly.map(item => ({ attemptId: item.attemptId, pid: null, custodyId: item.custodyId }))];
    const members = [...request.pids.map(({ attemptId, pid }) => ({ attemptId, pid, state: isAlive(pid) ? 'running' : 'exited' })),
      ...boundOnly.map(item => ({ attemptId: item.attemptId, pid: null, state: 'unknown' }))];
    const jobOwned = request.pids.filter(item => !item.custodyId);
    let jobProof;
    try { jobProof = await this.runJobProof(runId, { ...request, pids: jobOwned }, jobOwned.length); }
    catch (error) { jobProof = { containment: 'windows-job', confirmed: false, remainingMembers: null, reason: `The supervisor could not prove the run Job state: ${error.message}` }; }
    const hostProof = await this.hostTreeProof(hostOwned);
    const ownedAttempts = new Set([...request.pids.map(item => item.attemptId), ...hostOwned.map(item => item.attemptId)]).size;
    const confirmed = jobProof.confirmed && hostProof.confirmed;
    let outcome, reason, proofContainment = jobProof.containment;
    // A stop that only Host-owned trees made is contained by the Host's Job (a Windows Job); it is not a stop with no containment.
    if (confirmed && hostOwned.length) proofContainment = 'windows-job';
    // A proof that did not confirm names no containment: the label says what was proven.
    if (!confirmed) proofContainment = 'none';
    if (!request.observed) { outcome = 'termination_unconfirmed'; reason = 'This runtime instance did not observe the Stop request, so termination cannot be proven.'; proofContainment = 'none'; }
    else if (confirmed) { outcome = 'stopped'; reason = [jobProof.reason, hostProof.reason].filter(Boolean).join(' ').slice(0, 1000); }
    else { outcome = 'termination_unconfirmed'; reason = [jobProof.reason, hostProof.reason].filter(Boolean).join(' ').slice(0, 1000); }
    const proof = { schemaVersion: 1, kind: 'TerminationProof', runId, outcome, containment: proofContainment, controlMode: this.controlModeOf(runId),
      requestedAt: request.requestedAt, confirmedAt: outcome === 'stopped' ? nowIso() : null, ownedAttempts,
      remainingMembers: hostProof.confirmed ? (jobProof.remainingMembers ?? (outcome === 'stopped' ? 0 : null)) : null, members, reason };
    assertValid('execution-evidence.schema.json', 'terminationProof', proof, 'Termination proof');
    const artifact = this.store.putJson(proof);
    this.store.transaction(() => {
      this.store.run('INSERT INTO termination_proofs(id, run_id, outcome, containment, control_mode, requested_at, confirmed_at, proof_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        randomUUID(), runId, outcome, proof.containment, proof.controlMode, proof.requestedAt, proof.confirmedAt, artifact.artifactId, nowIso());
      if (this.store.get('SELECT journal_version AS v FROM runs WHERE id = ?', runId).v >= 2) this.store.appendEvents(runId, [{ type: 'run.termination_proof',
        payload: { proof: ref(artifact), outcome, containment: proof.containment, controlMode: proof.controlMode } }]);
    });
    // Only a confirmed stop drops the run Job; an unconfirmed one keeps it so kill-on-close still reaps the members.
    if (outcome === 'stopped') await Promise.resolve().then(() => this.supervisor?.releaseRun?.(runId)).catch(() => {});
    return proof;
  };

  // The run Job's proof. Without owned members it proves that the run Job has no member left (a run Job the supervisor never created has none);
  // without any supervisor, nothing else can own a member and the proof is the runtime's own record.
  P.runJobProof = async function runJobProof(runId, request, owned) {
    if (owned) return this.containmentFor(runId, request);
    if (!this.supervisor?.proveStopped) return { containment: 'none', confirmed: true, remainingMembers: 0, reason: 'The runtime owned no active process when Root Stop was requested; no owned member remains.' };
    // With no owned member there is no launch set, so the proof never claims native containment (containment 'none'). The run Job is still asked:
    // a member left in it (for example a grandchild of a finished command) keeps the Stop unconfirmed.
    const probe = await this.supervisor.proveStopped(runId, []);
    if (probe.remainingMembers === 0) return { containment: 'none', confirmed: true, remainingMembers: 0, reason: 'The runtime owned no active process when Root Stop was requested, and the run Job has no member left.' };
    if (probe.remainingMembers !== null) return { containment: 'none', confirmed: false, remainingMembers: probe.remainingMembers, reason: probe.reason };
    // The supervisor has no run Job for this run. That is a proof only when no process of this run was ever launched into a run Job; a run Job the
    // supervisor has lost is not a proof, so the Stop stays unconfirmed.
    const launched = this.store.get("SELECT 1 AS n FROM attempts a WHERE a.run_id = ? AND a.process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attempt_custody c WHERE c.attempt_id = a.id) LIMIT 1", runId);
    // Nothing was launched, so nothing is claimed about native containment: the proof is the runtime's own record, as for an empty launch set.
    if (!launched) return { containment: 'none', confirmed: true, remainingMembers: 0, reason: 'No process of this run was launched into a run Job, so no run Job member can remain.' };
    return { containment: 'none', confirmed: false, remainingMembers: null, reason: 'The supervisor holds no run Job for this run, so nothing proves that its members stopped.' };
  };

  // Host-owned process trees are proven by their Host: the custody record reports processTreeEnded only when the Job is drained.
  P.hostTreeProof = async function hostTreeProof(hostOwned) {
    for (const item of hostOwned) {
      let status = null;
      try {
        status = await this.custodyCall('custody.status', { custodyId: item.custodyId });
        // An invocation admitted but never launched is withdrawn, so that the Host can no longer turn it into a process; its tree is then ended.
        if (status?.state === 'admitted') status = await this.custodyCall('custody.cancel', { custodyId: item.custodyId });
      } catch { status = null; }
      if (status?.processTreeEnded !== true) return { confirmed: false, reason: `The Host has not proven that the process tree of attempt ${item.attemptId} ended.` };
    }
    return { confirmed: true, reason: hostOwned.length ? 'Every Host-owned process tree is proven ended by its Host.' : null };
  };

  P.containmentFor = async function containmentFor(runId, request) {
    if (!this.supervisor?.proveStopped) return { containment: 'none', confirmed: false, remainingMembers: null,
      reason: 'No native containment is available, so direct process exit is not proof that every member stopped.' };
    const result = await this.supervisor.proveStopped(runId, request.pids.map(item => item.pid));
    return { containment: result.containment, confirmed: result.confirmed === true, remainingMembers: result.remainingMembers ?? null, reason: result.reason };
  };

  P.latestTerminationOutcome = function latestTerminationOutcome(runId) {
    return this.store.get('SELECT outcome FROM termination_proofs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', runId)?.outcome ?? 'pending';
  };

  // ---------- Incidents ----------
  P.insertIncident = function insertIncident(observation, { runId = null, id = randomUUID() } = {}) {
    incidentContract(observation);
    const artifact = this.store.putJson(observation);
    const at = nowIso();
    this.store.run(`INSERT OR IGNORE INTO incidents(id, state, cause_status, severity, title, component, category, run_id, initial_artifact_id, stop_outcome_json, created_at, updated_at)
      VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`, id, observation.causeStatus, observation.severity, observation.title, observation.component, observation.category,
      runId, artifact.artifactId, at, at);
    return { incidentId: id, initial: ref(artifact) };
  };

  P.appendIncidentUpdate = function appendIncidentUpdate(incidentId, { kind, authority, body }) {
    const seq = this.store.get('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM incident_updates WHERE incident_id = ?', incidentId).seq;
    const artifact = this.store.putJson(body);
    this.store.run('INSERT INTO incident_updates(id, incident_id, seq, kind, authority, body_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(), incidentId, seq, kind, authority, artifact.artifactId, nowIso());
    this.store.run('UPDATE incidents SET updated_at = ? WHERE id = ?', nowIso(), incidentId);
    return seq;
  };

  P.fileIncident = function fileIncident(body) {
    contract('incidentFileRequest', body);
    return this.idempotent('POST /incidents', body.requestId, body, () => {
      if (body.observation.runId && !this.store.get('SELECT id FROM runs WHERE id = ?', body.observation.runId)) throw new ApiError(404, 'not_found', 'The incident names a run that does not exist.');
      const { incidentId, initial } = this.insertIncident(body.observation, { runId: body.observation.runId ?? null });
      return { status: 201, body: { incidentId, state: 'open', causeStatus: body.observation.causeStatus, initial } };
    });
  };

  P.appendObservation = function appendObservation(incidentId, body) {
    contract('incidentFileRequest', body);
    return this.idempotent(`POST /incidents/${incidentId}/observations`, body.requestId, { incidentId, ...body }, () => {
      if (!this.store.get('SELECT id FROM incidents WHERE id = ?', incidentId)) throw new ApiError(404, 'not_found', 'Incident not found.');
      incidentContract(body.observation);
      const seq = this.appendIncidentUpdate(incidentId, { kind: 'observation', authority: body.observation.reporter.authority, body: body.observation });
      return { status: 201, body: { incidentId, seq } };
    });
  };

  P.triageIncident = function triageIncident(incidentId, body, { authority = 'external' } = {}) {
    contract('incidentTriageRequest', body);
    return this.idempotent(`POST /incidents/${incidentId}/triage`, body.requestId, { incidentId, ...body }, () => {
      const incident = this.store.get('SELECT * FROM incidents WHERE id = ?', incidentId);
      if (!incident) throw new ApiError(404, 'not_found', 'Incident not found.');
      const state = body.state ?? incident.state;
      const causeStatus = body.causeStatus ?? incident.cause_status;
      this.store.run('UPDATE incidents SET state = ?, cause_status = ?, updated_at = ? WHERE id = ?', state, causeStatus, nowIso(), incidentId);
      const kind = body.state === 'closed' ? 'closure' : body.causeStatus ? 'cause' : 'triage';
      const seq = this.appendIncidentUpdate(incidentId, { kind, authority, body: { state, causeStatus, note: body.note ?? null } });
      return { status: 200, body: { incidentId, state, causeStatus, seq } };
    });
  };

  P.listIncidents = function listIncidents({ state = null, runId = null, limit = 50 } = {}) {
    const rows = this.store.all(`SELECT * FROM incidents WHERE (? IS NULL OR state = ?) AND (? IS NULL OR run_id = ?) ORDER BY updated_at DESC LIMIT ?`, state, state, runId, runId, Math.min(limit, 200));
    return { items: rows.map(row => ({ incidentId: row.id, state: row.state, causeStatus: row.cause_status, severity: row.severity, title: row.title,
      component: row.component, category: row.category, runId: row.run_id, createdAt: row.created_at, updatedAt: row.updated_at })) };
  };

  P.getIncident = function getIncident(incidentId) {
    const incident = this.store.get('SELECT * FROM incidents WHERE id = ?', incidentId);
    if (!incident) throw new ApiError(404, 'not_found', 'Incident not found.');
    const updates = this.store.all('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY seq', incidentId)
      .map(row => ({ seq: row.seq, kind: row.kind, authority: row.authority, body: this.store.readJson(row.body_artifact_id), createdAt: row.created_at }));
    return { incidentId, state: incident.state, causeStatus: incident.cause_status, severity: incident.severity, title: incident.title, component: incident.component,
      category: incident.category, runId: incident.run_id, createdAt: incident.created_at, updatedAt: incident.updated_at,
      initial: this.store.readJson(incident.initial_artifact_id), updates };
  };

  // Stop-and-report: the barrier and the initial incident commit together on a healthy store. If the report cannot be
  // stored, Stop still runs and the report is spooled outside SQLite for reconciliation.
  P.stopAndReport = function stopAndReport(runId, body, reporter) {
    contract('stopAndReportRequest', body);
    const incidentId = derivedUuid(body.requestId, 'incident');
    const stopRequestId = derivedUuid(body.requestId, 'stop');
    const observation = { ...body.observation, runId, reporter };
    let stopped = null, persisted = false, spool = null, persistError = null;
    try {
      this.store.transaction(() => {
        stopped = this.stopRun(runId, { requestId: stopRequestId });
        incidentContract(observation);
        this.insertIncident(observation, { runId, id: incidentId });
        persisted = true;
      });
    } catch (error) {
      persistError = error;
      try { stopped = this.stopRun(runId, { requestId: stopRequestId }); } catch (stopError) { persistError = stopError; }
      spool = this.spoolIncident(incidentId, { runId, observation, reason: error.message });
    }
    const row = this.store.get('SELECT state FROM runs WHERE id = ?', runId);
    return { status: stopped?.status ?? 202, body: { runId, requestId: body.requestId, state: row.state,
      termination: { outcome: this.latestTerminationOutcome(runId) },
      evidence: { recordedAt: nowIso(), outcome: 'streams-durable-as-written' },
      incident: persisted ? { incidentId, state: 'open', persisted: true } : { incidentId, persisted: false, spool, reason: persistError?.message ?? null } } };
  };

  // Written to a temporary file and renamed into place, so a crash or a full disk never leaves a truncated report. The
  // file name is the incident ID, so a retried report overwrites the same entry instead of failing.
  P.spoolIncident = function spoolIncident(incidentId, record) {
    const directory = join(this.store.root, 'spool', 'incidents');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${incidentId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ incidentId, spooledAt: nowIso(), ...record }, null, 2));
    renameSync(temporary, path);
    return path;
  };

  // Reconciles spooled reports into the registry. A file that cannot be read is quarantined and recorded as a capture
  // gap, so a damaged spool never blocks startup.
  P.reconcileIncidentSpool = function reconcileIncidentSpool() {
    const directory = join(this.store.root, 'spool', 'incidents');
    if (!existsSync(directory)) return [];
    const reconciled = [];
    for (const name of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      const path = join(directory, name);
      let spooled;
      try {
        spooled = JSON.parse(readFileSync(path, 'utf8'));
        incidentContract(spooled.observation);
      } catch (error) {
        this.quarantineSpoolFile(path, name, error);
        continue;
      }
      if (spooled.runId && !this.store.get('SELECT id FROM runs WHERE id = ?', spooled.runId)) continue;
      this.store.transaction(() => this.insertIncident(spooled.observation, { runId: spooled.runId ?? null, id: spooled.incidentId }));
      rmSync(path, { force: true });
      reconciled.push(spooled.incidentId);
    }
    return reconciled;
  };

  P.quarantineSpoolFile = function quarantineSpoolFile(path, name, error) {
    const quarantine = join(dirname(path), 'quarantine');
    mkdirSync(quarantine, { recursive: true });
    renameSync(path, join(quarantine, name));
    const id = randomUUID();
    this.insertIncident({ schemaVersion: 1, kind: 'IncidentObservation', title: 'An incident report could not be reconciled from the spool', component: 'incident-spool',
      category: 'capture_gap', severity: 'medium', confidence: 'high', causeStatus: 'confirmed', expected: 'Every spooled incident report is readable and reconciled.',
      actual: `The spool file ${name} could not be read (${error.message}); it was moved to quarantine.`, reproduction: [],
      versions: { app: null, runtime: null, cli: null }, sourceRevision: null, runId: null, nodeInstanceId: null, attemptId: null, eventRange: null,
      artifacts: [], captureGaps: [`Spool file ${name} is quarantined.`], controllerCommandId: null, reporter: { authority: 'system', sessionId: null } }, { id });
  };

  // ---------- Audit bundles ----------
  // The bundle is built without blocking the event loop: objects are hashed as streams and copied asynchronously, and the
  // journal walk yields periodically. Only the receipt and the rows commit in a transaction, after the files are complete.
  P.createAuditBundle = async function createAuditBundle(runId, body) {
    contract('auditBundleRequest', body);
    const command = `POST /runs/${runId}/audit-bundles`;
    const payload = { runId, ...body };
    const digest = canonicalHash({ command, payload });
    const replay = this.store.get('SELECT command, payload_sha256, response_artifact_id FROM command_receipts WHERE request_id = ?', body.requestId);
    if (replay) {
      if (replay.payload_sha256 !== digest || replay.command !== command) throw new ApiError(409, 'conflict', 'This requestId was already used for a different command or payload.');
      return { status: 201, body: this.store.readJson(replay.response_artifact_id) };
    }
    const row = this.requireRun(runId);
    const bundle = await this.buildAuditBundle(row, body.profile);
    return this.store.transaction(() => {
      const again = this.store.get('SELECT response_artifact_id FROM command_receipts WHERE request_id = ?', body.requestId);
      if (again) {
        // A concurrent identical request committed first; keep its bundle and discard this one.
        rmSync(bundle.directory, { recursive: true, force: true });
        return { status: 201, body: this.store.readJson(again.response_artifact_id) };
      }
      this.store.run('INSERT INTO audit_exports(id, run_id, profile, pinned_sequence, state, manifest_artifact_id, directory, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        bundle.exportId, row.id, body.profile, bundle.pinnedSequence, bundle.state, bundle.manifestArtifactId, bundle.directory, bundle.generatedAt);
      const response = bundle.summary;
      const artifact = this.store.putJson(response);
      this.store.run('INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at) VALUES (?, ?, ?, ?, ?)',
        body.requestId, command, digest, artifact.artifactId, nowIso());
      return { status: 201, body: response };
    });
  };

  P.buildAuditBundle = async function buildAuditBundle(row, profile) {
    const exportId = randomUUID();
    const directory = join(this.store.root, 'exports', exportId);
    // Written in place: a rename of a fresh directory is not atomic on every Windows volume.
    await mkdir(join(directory, 'objects'), { recursive: true });
    const pinned = row.last_sequence;
    const terminal = TERMINAL.has(row.state);
    const journal = this.store.all('SELECT sequence, envelope_json FROM journal_events WHERE run_id = ? AND sequence <= ? ORDER BY sequence', row.id, pinned);
    const members = [], written = new Set(), omissions = [];
    const write = async (path, bytes, role, completeness) => {
      const full = join(directory, ...path.split('/'));
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, bytes);
      members.push({ path, sha256: sha256(bytes), byteSize: bytes.length, role, completeness });
      written.add(path);
    };
    await write('journal.jsonl', Buffer.from(journal.map(item => `${item.envelope_json}\n`).join(''), 'utf8'), 'journal', terminal ? 'complete' : 'partial');

    // Reference closure: every artifact a journaled envelope or a run, evidence, proof or incident record names.
    const refs = new Map();
    for (let index = 0; index < journal.length; index += 1) {
      collectRefs(JSON.parse(journal[index].envelope_json), refs);
      if (index % 1000 === 999) await yieldToEventLoop();
    }
    for (const id of [row.workflow_snapshot_artifact_id, row.settings_artifact_id]) if (id) refs.set(id, null);
    for (const table of ['execution_evidence', 'termination_proofs']) for (const record of this.store.all(`SELECT * FROM ${table} WHERE run_id = ?`, row.id)) refs.set(record.evidence_artifact_id ?? record.proof_artifact_id, null);
    for (const incident of this.store.all('SELECT * FROM incidents WHERE run_id = ?', row.id)) refs.set(incident.initial_artifact_id, null);
    for (const update of this.store.all('SELECT u.body_artifact_id FROM incident_updates u JOIN incidents i ON i.id = u.incident_id WHERE i.run_id = ?', row.id)) refs.set(update.body_artifact_id, null);

    const taskRecords = {
      tasks: this.store.all('SELECT * FROM managed_tasks WHERE run_id=? ORDER BY created_at', row.id),
      assessments: this.store.all('SELECT * FROM task_assessments WHERE assessment_run_id=? ORDER BY created_at', row.id),
      plans: this.store.all('SELECT * FROM execution_plans WHERE execution_run_id=? ORDER BY created_at', row.id),
      acceptance: this.store.all('SELECT * FROM acceptance_records WHERE run_id=? ORDER BY created_at', row.id),
      deliveries: this.store.all('SELECT * FROM branch_deliveries WHERE run_id=? ORDER BY created_at', row.id),
      operations: this.store.all('SELECT * FROM delivery_operations WHERE run_id=? ORDER BY updated_at', row.id),
      work: this.store.all('SELECT w.* FROM task_work w JOIN managed_tasks t ON t.id=w.task_execution_id WHERE t.run_id=? ORDER BY w.started_at', row.id),
      evidence: this.store.all('SELECT e.* FROM task_evidence e JOIN managed_tasks t ON t.id=e.task_execution_id WHERE t.run_id=? ORDER BY e.created_at', row.id),
    };
    if (taskRecords.tasks.length) {
      for (const records of Object.values(taskRecords)) for (const record of records) for (const [key, id] of Object.entries(record)) if (key.endsWith('_artifact_id') && id) refs.set(id, null);
      await write('tasks.json', canonicalBytes(taskRecords), 'evidence', terminal ? 'complete' : 'partial');
    }

    const omittedCategories = new Set(); let artifactGaps = false;
    for (const artifactId of refs.keys()) {
      const artifact = this.store.artifactRow(artifactId);
      if (!artifact) { artifactGaps = true; omissions.push({ category: `artifact ${artifactId}`, reason: 'The referenced object is missing from the store.' }); continue; }
      if (refs.get(artifactId) && refs.get(artifactId) !== artifact.sha256) { artifactGaps = true; omissions.push({ category: `artifact ${artifactId}`, reason: 'The reference digest differs from the stored object identity.' }); continue; }
      if (profile === 'shareable' && artifact.media_type === 'application/octet-stream') { omittedCategories.add('raw-process-streams'); continue; }
      const path = `objects/${artifact.sha256}`;
      if (written.has(path)) continue;
      const source = join(this.store.storeDir, artifact.relative_path);
      // The stored object is verified and copied as a stream, so a large object never blocks the event loop.
      if (await digestOfFile(source) !== artifact.sha256) { artifactGaps = true; omissions.push({ category: `artifact ${artifactId}`, reason: 'The stored object failed its digest check and was not exported.' }); continue; }
      // Follow immutable JSON manifests transitively, including candidate files and check evidence.
      if (artifact.media_type === 'application/json') collectRefs(this.store.readJson(artifactId), refs);
      await copyFile(source, join(directory, ...path.split('/')));
      members.push({ path, sha256: artifact.sha256, byteSize: artifact.byte_size, role: 'object', completeness: 'complete' });
      written.add(path);
    }
    for (const category of omittedCategories) omissions.push({ category, reason: 'Omitted from the shareable profile; the private local profile keeps it.' });

    const incidents = this.store.all('SELECT id FROM incidents WHERE run_id = ? ORDER BY created_at', row.id).map(item => this.getIncident(item.id));
    await write('incidents.json', canonicalBytes({ incidents }), 'incidents', 'complete');
    await write('evidence.json', canonicalBytes({ evidence: this.runEvidence(row.id) }), 'evidence', terminal ? 'complete' : 'partial');
    const proofs = this.store.all('SELECT * FROM termination_proofs WHERE run_id = ? ORDER BY created_at', row.id).map(item => ({ outcome: item.outcome, containment: item.containment, controlMode: item.control_mode, proof: referenceOf(this.store.artifactRow(item.proof_artifact_id)) }));
    await write('termination.json', canonicalBytes({ proofs }), 'termination', terminal ? 'complete' : 'unknown');

    const openStreams = this.store.get(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT attempt_id, json_extract(envelope_json, '$.payload.stream') AS stream FROM journal_events
      WHERE run_id = ? AND event_type = 'attempt.log_chunk' AND sequence <= ?) c WHERE NOT EXISTS (SELECT 1 FROM journal_events e WHERE e.run_id = ? AND e.event_type = 'attempt.log_stream_closed'
      AND e.attempt_id = c.attempt_id AND json_extract(e.envelope_json, '$.payload.stream') = c.stream)`, row.id, pinned, row.id).n;
    const incompleteCaptures = this.store.get("SELECT COUNT(*) AS n FROM journal_events WHERE run_id=? AND sequence<=? AND event_type='attempt.log_stream_closed' AND json_extract(envelope_json,'$.payload.integrity')<>'complete'", row.id, pinned).n;
    const verdict = terminal && openStreams === 0 && incompleteCaptures === 0 && !artifactGaps ? 'complete' : 'partial';
    const generatedAt = nowIso();
    const verdictText = verdict === 'complete' ? 'complete' : `partial (${openStreams} open stream(s), ${incompleteCaptures} incomplete capture(s), artifact gaps ${artifactGaps}, run ${row.state})`;
    await write('index.md', Buffer.from([`# Audit bundle ${exportId}`, '', `Run ${row.id}, state ${row.state}, pinned to journal sequence ${pinned}.`,
      `Profile: ${profile}. Verdict: ${verdictText}.`, `Journal events: ${journal.length}. Incidents: ${incidents.length}. Termination proofs: ${proofs.length}.`,
      '', 'Known omissions:', ...(omissions.length ? omissions.map(item => `- ${item.category}: ${item.reason}`) : ['- none']), ''].join('\n'), 'utf8'), 'index', 'complete');
    const redactionManifest = [{ category: 'runtime and controller credentials', reason: 'Never written to the journal, streams or records; excluded from both profiles.' }];
    if (profile === 'shareable') redactionManifest.push({ category: 'raw-process-streams', reason: 'Raw provider and check output is omitted from the shareable profile.' });
    const manifest = { schemaVersion: 1, kind: 'AuditManifest', exportId, runId: row.id, profile, pinnedSequence: pinned, runState: row.state,
      verdict, generatedAt, controlMode: this.controlModeOf(row.id), members, omissions, redactionManifest };
    try { assertValid('audit-manifest.schema.json', 'auditManifest', manifest, 'Audit manifest'); }
    catch (error) { rmSync(directory, { recursive: true, force: true }); throw new ApiError(500, 'internal', `The audit manifest could not be built: ${error.message}`); }
    await writeFile(join(directory, 'manifest.json'), canonicalBytes(manifest));
    const manifestRef = this.store.putJson(manifest);
    const state = verdict === 'complete' ? 'complete' : 'partial';
    return { exportId, directory, pinnedSequence: pinned, state, manifestArtifactId: manifestRef.artifactId, generatedAt,
      summary: { exportId, runId: row.id, profile, pinnedSequence: pinned, state, directory, manifestSha256: sha256(canonicalBytes(manifest)), memberCount: members.length } };
  };

  P.getAuditBundle = function getAuditBundle(exportId) {
    const row = this.store.get('SELECT * FROM audit_exports WHERE id = ?', exportId);
    if (!row) throw new ApiError(404, 'not_found', 'Audit bundle not found.');
    const manifestPath = join(row.directory, 'manifest.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
    return { exportId, runId: row.run_id, profile: row.profile, pinnedSequence: row.pinned_sequence, state: row.state, createdAt: row.created_at, directory: row.directory,
      present: manifest !== null, manifest };
  };

  // ---------- Command reconciliation ----------
  P.commandStatus = function commandStatus(requestId) {
    const receipt = this.store.get('SELECT command, response_artifact_id, created_at FROM command_receipts WHERE request_id = ?', requestId);
    if (!receipt) return { requestId, state: 'unknown', command: null, response: null };
    return { requestId, state: 'committed', command: receipt.command, committedAt: receipt.created_at, response: this.store.readJson(receipt.response_artifact_id) };
  };
}
