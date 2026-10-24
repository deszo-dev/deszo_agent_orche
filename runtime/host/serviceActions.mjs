import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { canonicalHash, canonicalize, sha256 } from '../core/canonical.mjs';
import { HostError, sameProcess } from './authority.mjs';
import { derivedUuid } from '../core/supervision.mjs';
import { inspectObservation } from './observation.mjs';
import { IncidentOutbox } from './incidentOutbox.mjs';
import { boundedRuntimeJson } from './runtimeHttp.mjs';
import { reconcileStoppedPolicy } from './workerReconciliation.mjs';
import { executeJudgeReview } from './judgeDelivery.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));
const requireValue = (value, message) => { if (!value) throw new HostError(403, 'scoped_action_refused', message); };
export function installedActions({ host, installation, native, queue, installRoot, request = fetch, judgeRuntime = null }) {
  const watches = new Map(), pages = new Map();
  const incidents = new IncidentOutbox({ host }); incidents.recover();
  function runtime(policyId) {
    const pair = [...host.runtimeRegistrations.entries()].find(([, r]) => r.policyId === policyId && r.ready && r.endpoint);
    requireValue(pair, 'No ready runtime exists for this policy.'); return { generation: pair[0], ...pair[1] };
  }
  async function http(registration, method, path, body = null, controllerToken = null) {
    // Endpoint and the external-only token were received from the independently registered Node process.
    const response = await request(`http://127.0.0.1:${registration.endpoint.port}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${registration.endpoint.token}`, 'Content-Type': 'application/json', ...(controllerToken ? { 'X-Deszo-Controller-Token': controllerToken } : {}) }, body: body === null ? undefined : JSON.stringify(body) });
    const result = await boundedRuntimeJson(response);
    if (!response.ok) throw new HostError(response.status, result.code || 'runtime_refused', result.message || 'Runtime refused the action.'); return result;
  }
  async function flushIncidents(policyId) {
    let registration; try { registration = runtime(policyId); } catch { return { pending: true, reason: 'no_registered_runtime' }; }
    const profileId = JSON.parse(host.policyRow(policyId).decision_json).scope.dataProfile, results = [];
    for (const row of host.all("SELECT request_id FROM incident_outbox WHERE policy_id=? AND state='pending' ORDER BY created_at LIMIT 20", policyId)) {
      try { results.push(await incidents.deliver(row.request_id, { profileId, storeId: registration.ready.storeId, post: body => http(registration,'POST','/api/v2/incidents',body) })); }
      catch (error) { results.push({ requestId: row.request_id, state: 'pending', reason: error.message }); }
    }
    return { results };
  }
  async function failWatch(itemId, error, evidence = {}) {
    const state = watches.get(itemId), row = host.get('SELECT * FROM controller_queue WHERE item_id=?', itemId);
    requireValue(row, 'No durable queue item owns this failure.');
    const policy = JSON.parse(host.policyRow(row.policy_id).decision_json), cursor = state?.cursor ?? 0;
    const observation = { schemaVersion: 1, kind: 'IncidentObservation', title: 'Restricted controller stopped work after a supervision or transport defect', component: 'supervision', category: 'worker_observation_defect', severity: 'critical', confidence: 'high', causeStatus: 'suspected',
      expected: 'A supervised run has processed contiguous observations, a live scoped controller and bounded transport.', actual: String(error.message || error).slice(0,4000), reproduction: ['Inspect the protected host worker observation and incident outbox records.'],
      versions: { app: null, runtime: null, cli: null }, sourceRevision: null, runId: state?.runId ?? null, nodeInstanceId: null, attemptId: null,
      eventRange: { fromSequence: cursor, toSequence: Number.isInteger(evidence.nextCursor) ? evidence.nextCursor : cursor }, artifacts: [], captureGaps: ['Native termination and raw observation evidence are retained in the protected host audit/outbox.'], controllerCommandId: row.step_request_id, reporter: { authority: 'external', sessionId: null } };
    let registration = state?.registration; if (!registration) { try { registration = runtime(row.policy_id); } catch {} }
    const spooled = incidents.enqueue({ requestId: derivedUuid(row.step_request_id || itemId,'worker-incident'), policyId: row.policy_id, itemId, profileId: policy.scope.dataProfile, storeId: registration?.ready?.storeId ?? null, observation });
    let termination;
    try { termination = await native('stopDomain',{ domain: row.policy_id }); }
    catch (stopError) { termination = { terminationConfirmed: false, reason: stopError.message }; }
    incidents.termination(spooled.requestId, termination);
    host.audit('worker.incident', { itemId, requestId: spooled.requestId, evidence, termination }, { policyId: row.policy_id });
    watches.delete(itemId); pages.delete(itemId);
    // The domain may contain the application itself. Reporting survives that death and is retried only against
    // the original verified profile/store using the engine's stable request receipt, never by launching work here.
    await flushIncidents(row.policy_id);
    return { outcome: termination.terminationConfirmed === true ? 'stopped' : 'reconciling', reason: 'suspected_deszo_defect', runId: observation.runId, incident: incidents.get(spooled.requestId), termination };
  }
  function workspace(policy, workspaceId) {
    const profile = host.get('SELECT * FROM data_profiles WHERE profile_id=?', policy.scope.dataProfile); requireValue(profile, 'Profile is not registered.');
    const db = new DatabaseSync(join(profile.profile_path, 'store', 'state.sqlite'), { readOnly: true });
    let row; try { row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId); } finally { db.close(); }
    const rule = policy.scope.workspaces.find(w => w.workspaceId === workspaceId); requireValue(row && rule, 'Workspace is outside the decided profile.');
    const path = realpathSync.native(resolve(row.cwd)), identity = sha256(Buffer.from(process.platform === 'win32' ? path.toLowerCase() : path));
    requireValue(identity === rule.cwdIdentity && row.cwd_identity === identity, 'Actual workspace identity differs from consent.'); return path;
  }
  async function command({ connection, policyId, requestId, step }) {
    const policy = JSON.parse(host.policyRow(policyId).decision_json), operation = step.type === 'command.build' ? 'build.run' : 'check.run';
    const allowed = policy.scope.commands.find(c => c.commandId === step.args.commandId); requireValue(allowed, 'Command is outside consent.');
    const root = workspace(policy, step.args.workspaceId), cwd = resolve(root, allowed.cwdRelative), rel = relative(root, cwd);
    requireValue(!isAbsolute(rel) && !rel.startsWith('..') && resolve(realpathSync(cwd)).toLowerCase() === cwd.toLowerCase(), 'Command working directory escaped its workspace.');
    const executable = allowed.command === 'node' ? join(installRoot, 'node.exe') : allowed.command;
    requireValue(isAbsolute(executable) && /\.exe$/i.test(executable), 'An exact absolute executable is required; shell/batch execution must be explicitly specified in consent.');
    const receipt = host.decide({ requestId, policyId, operation, commandId: allowed.commandId, workspaceId: step.args.workspaceId, cost: {}, justification: `worker exact command ${allowed.commandId}` }, { connectionId: connection.controller.connectionId });
    if (receipt.outcome !== 'approved') return { outcome: 'failed', reason: receipt.reason };
    const admission = host.admit(receipt.permitId); if (!admission.admitted) { host.settle(receipt.permitId, { effect: 'not_executed', evidence: admission.reason }); return { outcome: 'failed', reason: admission.reason }; }
    const { operationId } = host.beginOperation({ permitId: receipt.permitId, kind: operation, intent: { commandId: allowed.commandId, workspaceId: step.args.workspaceId, cwd, executable, arguments: allowed.args } });
    const document = JSON.stringify({ operationId, executable, cwd, arguments: allowed.args, timeoutMs: Math.min(allowed.timeoutMs, admission.enforcementDeadlineMs) });
    host.recordPhase(operationId, 'command_prepared', { commandSpecSha256: sha256(Buffer.from(document)) });
    try {
      const nativeDeadlineMs=Math.min(allowed.timeoutMs+20000,admission.enforcementDeadlineMs,host.status(policyId).remainingMs);
      const process = await native('launch', { domain: `${policyId}:work:${operationId}`, remainingMs: nativeDeadlineMs, deadlineUptimeMs: host.time.uptimeMs()+nativeDeadlineMs, expiresAt: host.policyRow(policyId).expires_at, executable: join(installRoot, 'deszo-control.exe'), arguments: ['command'], cwd: root, environment: { DESZO_COMMAND_SPEC: document } });
      host.recordPhase(operationId, 'command_started', { launch: process });
      const deadline = Date.now() + Math.min(allowed.timeoutMs, admission.enforcementDeadlineMs) + 10000; let result = null, exit;
      do {
        result = JSON.parse(host.operationRow(operationId).evidence_json).commandResult;
        exit = await native('processExit', { process });
        if (result && exit.exited) break;
        await pause(100);
      } while (Date.now() < deadline);
      if (!result || !exit.exited || exit.exitCode !== (result.exitCode >>> 0)) throw new HostError(409, 'command_effect_unknown', 'No matching native exit and command report was obtained.');
      const success = result.exitCode === 0 && !result.timedOut && !result.captureTruncated;
      if (result.timedOut) await native('stopDomain', { domain: policyId });
      host.finishOperation(operationId, { outcome: success ? 'verified' : 'failed', reason: success ? null : result.captureTruncated ? 'capture_incomplete' : 'command_failed', evidence: { commandResult: result, nativeExit: exit, verification: { complete: !result.captureTruncated, chain: ['exact-policy-command', 'owned-native-process', 'protected-reporter', 'native-exit'] } } });
      host.settle(receipt.permitId, { effect: 'consumed', evidence: `command ${operationId} exit ${result.exitCode}` });
      return { outcome: success ? 'succeeded' : 'failed', operationId, result, nativeExit: exit };
    } catch (error) {
      host.finishOperation(operationId, { outcome: 'reconciling', reason: error.message }); host.settle(receipt.permitId, { effect: 'unknown', evidence: error.message });
      await native('stopDomain', { domain: policyId }); return { outcome: 'reconciling', operationId, reason: error.message };
    }
  }
  async function completeCommand(p, peer) {
    let op = host.operationRow(p.operationId), end = Date.now() + 5000;
    while (op.phase === 'command_prepared' && op.outcome === 'in_progress' && Date.now() < end) { await pause(25); op = host.operationRow(p.operationId); }
    const evidence = JSON.parse(op.evidence_json);
    requireValue(peer.nativeMode === 'command' && sameProcess(evidence.launch, peer) && ['check.run', 'build.run'].includes(op.kind), 'Command evidence belongs to another native process.');
    requireValue(p.specSha256 === evidence.commandSpecSha256 && Number.isInteger(p.exitCode) && typeof p.timedOut === 'boolean' && typeof p.captureTruncated === 'boolean' && typeof p.stdout === 'string' && typeof p.stderr === 'string' && p.stdout.length <= 65536 && p.stderr.length <= 65536, 'Command report differs or exceeds its bound.');
    if (evidence.commandResult) { requireValue(canonicalHash(evidence.commandResult) === canonicalHash(p), 'Command evidence cannot be replaced.'); return { recorded: true, replayed: true }; }
    host.recordPhase(p.operationId, 'command_reported', { commandResult: p }); return { recorded: true };
  }
  async function startWorkflow({ connection, policyId, requestId, step, itemId }) {
    const policy = JSON.parse(host.policyRow(policyId).decision_json), registration = runtime(policyId), binding = step.args;
    workspace(policy, binding.workspaceId);
    const session = await http(registration, 'POST', '/api/v2/controller-sessions', { requestId: derivedUuid(requestId, 'session'), clientLabel: 'Installed Deszo deterministic controller', clientProvider: 'deszo-worker' });
    requireValue(session.controllerToken, 'A lost controller-session credential requires reconciliation.');
    const grant = await http(registration, 'POST', '/api/v2/control-grants', { requestId: derivedUuid(requestId, 'grant'), controllerSessionId: session.controllerSessionId, ...binding, clientProvider: 'deszo-worker', clientVersion: '1',
      requestedActions: ['observe','acknowledge','stop','stop-and-report'], observationDeadlineMs: 30000, escalationDeadlineMs: 90000 }, session.controllerToken);
    const grantPermit = host.decide({ requestId: derivedUuid(requestId, 'grant-permit'), policyId, operation: 'supervision.approve', ...binding, runtimeGeneration: registration.generation, cost: {} }, { connectionId: connection.controller.connectionId });
    requireValue(grantPermit.outcome === 'approved', grantPermit.reason);
    await http(registration, 'POST', `/api/v2/control-grants/${grant.grantId}/host-approval`, { requestId: derivedUuid(requestId, 'grant-approval'), hostPermitId: grantPermit.permitId });
    const permit = host.decide({ requestId: derivedUuid(requestId, 'run-permit'), policyId, operation: 'run.approve', ...binding, runtimeGeneration: registration.generation, cost: {} }, { connectionId: connection.controller.connectionId });
    requireValue(permit.outcome === 'approved', permit.reason);
    const created = await http(registration, 'POST', '/api/v2/runs', { requestId, ...binding, controlGrantId: grant.grantId, hostPermitId: permit.permitId }, session.controllerToken);
    requireValue(created.run?.runId && created.outcome === 'created', 'The engine did not create the supervised run.');
    watches.set(itemId, { registration, runId: created.run.runId, controllerToken: session.controllerToken, controllerSessionId: session.controllerSessionId, cursor: 0, policyId });
    return { waiting: true, runId: created.run.runId, runtimeGeneration: registration.generation, grantId: grant.grantId, cursor: 0 };
  }
  async function watch(itemId) {
    const state = watches.get(itemId); requireValue(state, 'Worker watch state was lost; reconciliation is required.');
    const raw = await http(state.registration, 'GET', `/api/v2/runs/${state.runId}/watch?cursor=${state.cursor}&waitMs=1000`);
    const page = { ...raw, observationId: randomUUID(), receivedAt: new Date().toISOString() };
    pages.set(itemId, page); return { page, runId: state.runId, cursor: state.cursor };
  }
  async function observed(itemId, observation, workerId) {
    const state = watches.get(itemId), page = pages.get(itemId); requireValue(state && page, 'No retrieved observation awaits processing.');
    const expected = inspectObservation(page, { runId: state.runId, cursor: state.cursor });
    requireValue(canonicalHash(expected) === canonicalHash(observation), 'Acknowledgement does not match the processed page.');
    host.audit('worker.observation_processed', { itemId, workerId, ...observation }, { policyId: state.policyId });
    pages.delete(itemId);
    if (observation.verdict === 'stop') {
      return failWatch(itemId,new Error(observation.problems.join(' ')),{ nextCursor: page.nextCursor, pageDigest: canonicalHash(page), processedObservation: observation });
    }
    // A fresh engine health snapshot is also inspected in the worker. No timer, heartbeat or mere HTTP retrieval
    // reaches this path: it requires the matching processed-page digest from the registered worker process.
    await http(state.registration, 'POST', `/api/v2/runs/${state.runId}/observation-acks`, { requestId: randomUUID(), cursor: page.nextCursor }, state.controllerToken);
    state.cursor = page.nextCursor;
    if (page.terminal) {
      const audit = await http(state.registration, 'POST', `/api/v2/runs/${state.runId}/audit-bundles`, { requestId: randomUUID(), profile: 'private-local' }, state.controllerToken);
      watches.delete(itemId); return { outcome: page.state === 'succeeded' ? 'succeeded' : 'failed', runId: state.runId, state: page.state, audit };
    }
    return { waiting: true, runId: state.runId, cursor: state.cursor };
  }
  async function execute(params) {
    if(params.step.type==='judge.review')return executeJudgeReview({host,queue,...params,runtime:judgeRuntime});
    if (params.step.type.startsWith('command.')) return command(params);
    if (params.step.type === 'workflow.run') return startWorkflow(params);
    if (params.step.type === 'evidence.audit') return { outcome: 'succeeded', audit: await http(runtime(params.policyId), 'POST', `/api/v2/runs/${params.step.args.runId}/audit-bundles`, { requestId: params.requestId, profile: 'private-local' }) };
    throw new HostError(400, 'unsupported_step', 'Unsupported typed controller operation.');
  }
  async function reconcile(itemId) {
    const row = host.get('SELECT * FROM controller_queue WHERE item_id=?',itemId); requireValue(row, 'No durable item owns this reconciliation.');
    if (row.state === 'stopped') return queue.status(itemId);
    requireValue(row.state === 'reconciling', 'This item is not awaiting reconciliation.');
    const evidence = await reconcileStoppedPolicy({host,native,policyId:row.policy_id});
    return queue.reconcileStopped(itemId,evidence);
  }
  // Files an externally observed incident in the protected outbox under its policy. The profile comes from the policy, never
  // from the caller. Filing is evidence only: delivery still needs a ready runtime of that profile, so it starts nothing,
  // charges nothing and grants no authority.
  function spoolIncident({ policyId, requestId, observation }) {
    requireValue(policyId && requestId && observation, 'An incident spool needs a policy, a request identity and an observation.');
    const profileId = JSON.parse(host.policyRow(policyId).decision_json).scope.dataProfile;
    return incidents.enqueue({ requestId, policyId, itemId: null, profileId, storeId: null, observation });
  }
  return { execute, completeCommand, watch, observed, failWatch, flushIncidents, spoolIncident, incidents, reconcile };
}
