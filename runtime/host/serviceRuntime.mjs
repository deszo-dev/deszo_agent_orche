// Protected service child protocol. Public clients cannot supply connection identity or invoke native commands.
// The installed C# SCM service is the sole stdin writer and sole owner of the native Jobs.
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { ControlHost, HostError, sameProcess } from './authority.mjs';
import { canonicalBytes, canonicalHash, canonicalize, parseStrictJson } from '../core/canonical.mjs';
import { WebAuthnConsent } from './webauthn.mjs';
import { CAPABILITIES } from './capabilities.mjs';
import { ControllerQueue } from './controllerQueue.mjs';
import { installedLifecycle } from './serviceLifecycle.mjs';
import { installedActions } from './serviceActions.mjs';
import { InstalledEnablement } from './installedEnablement.mjs';
import { reregisterInstalledRuntime } from './runtimeRecovery.mjs';
import { reconcileStoppedPolicy } from './workerReconciliation.mjs';
import { derivedUuid } from '../core/supervision.mjs';

const pending = new Map(), connections = new Map();
let host, installation, consent, queue, workerKeys, lifecycle, actions, enablement, lastWorker = null, workerError = null;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const native = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new HostError(504, 'native_timeout', `Native ${method} outcome is unknown.`)); }, 20_000);
  pending.set(id, { resolve: resolvePromise, reject, timer }); send({ native: { id, method, params } });
});
const answer = (connectionId, message) => send({ connectionId, message });
const required = (value, message) => { if (!value) throw new HostError(403, 'native_identity_required', message); };
function broker(peer) {
  required(peer?.verifiedByService && peer.nativeMode === 'broker' && peer.elevatedAdministrator && peer.administratorMember && peer.integritySid === 'S-1-16-12288' && peer.userSid === installation.userSid, 'A protected elevated broker for the authorized user is required.');
}
function operator(peer) { required(peer?.verifiedByService && peer.elevatedAdministrator && peer.administratorMember && peer.integritySid === 'S-1-16-12288' && peer.userSid === installation.userSid, 'This operation belongs to the elevated installation operator.'); }
async function worker(connection) {
  const observed = await native('workerIdentity'), parent = connection.peer.parent;
  required(connection.peer.nativeMode === 'client' && observed.available && sameProcess(observed.process, parent) && !parent.administratorMember && parent.integritySid === 'S-1-16-8192', 'Only the launcher-created restricted worker may use this protocol.');
  required(canonicalHash(connection.peer.parentArguments) === canonicalHash([join(import.meta.dirname, 'node.exe'), '--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'worker.mjs')]), 'The worker command line differs from the fixed installation.');
  return `${parent.pid}:${parent.creationTime}`;
}
function party(connection, permit) {
  if (connection.controller?.policyId === permit.policyId) return host.requireController(connection.controller.connectionId, permit.policyId);
  host.requireRuntimeParty(connection.runtime, permit.policyId, permit.request.runtimeGeneration);
}
function overview() {
  return { assurance: host.assurance, autonomyEnabled: host.assurance === 'production', enrolled: Boolean(consent.credential()),
    missingCapabilities: enablement.missing(),
    pending: host.all('SELECT challenge_id, decision_json, decision_digest, expires_at FROM consent_challenges WHERE consumed_at IS NULL AND expires_at > ? ORDER BY issued_at', new Date(host.time.wallNow()).toISOString())
      .map(row => ({ challengeId: row.challenge_id, decisionDigest: row.decision_digest, expiresAt: row.expires_at, decision: JSON.parse(row.decision_json) })),
    activePolicies: host.all("SELECT policy_id FROM policies WHERE state = 'active'").map(row => host.status(row.policy_id)) };
}
async function route(connection, message) {
  const p = message.params || {}, peer = connection.peer;
  switch (message.method) {
    case 'host.overview': return overview();
    case 'host.scope-options': return { buildRoot: installation.buildRoot, desktop: { user: installation.userSid, sessionId: peer.sessionId }, profiles: host.all('SELECT profile_id AS profileId,profile_path AS path FROM data_profiles ORDER BY profile_id') };
    case 'consent.open': required(peer.userSid === installation.userSid && peer.sessionId > 0, 'The authorized desktop user is required.'); return native('openConsent');
    case 'policy.revoke_user': required(peer.userSid === installation.userSid, 'The authorized desktop user is required.'); return host.revoke(p.policyId, { actor: `native verified user ${peer.userSid}` });
    case 'host.health': return { ...await native('health'), assurance: host.assurance, hostInstance: host.hostInstance, bootId: host.time.bootId() };
    case 'worker.identity': return { controllerId: workerKeys.controllerId, publicKey: workerKeys.publicKey, mode: 'deterministic', provider: 'none', model: 'none', effort: 'none', billing: 'no-worker-model-calls' };
    case 'worker.status': return { lastObserved: lastWorker, error: workerError, queue: host.all('SELECT item_id,policy_id,state,step_index,reason FROM controller_queue ORDER BY created_at DESC LIMIT 100'), pendingIncidents: host.all("SELECT request_id,policy_id,run_id,state,last_error FROM incident_outbox WHERE state!='registered' ORDER BY created_at LIMIT 100") };
    case 'incidents.flush': required(connection.controller?.policyId === p.policyId || peer.userSid === installation.userSid, 'Incident delivery belongs to the authorized profile user/controller.'); return actions.flushIncidents(p.policyId);
    case 'incidents.spool': required(peer.userSid === installation.userSid && peer.sessionId > 0, 'Filing an incident belongs to the authorized desktop user.'); return actions.spoolIncident(p);
    case 'queue.enqueue': required(connection.controller, 'An authenticated controller is required.'); return queue.enqueue(p, connection.controller.connectionId);
    case 'queue.status': { const result = queue.status(p.itemId); required(connection.controller?.policyId === result.policyId || peer.userSid === installation.userSid, 'Wrong queue scope.'); return result; }
    case 'queue.reconcile': {
      const row = queue.status(p.itemId); if (connection.controller?.policyId !== row.policyId) operator(peer);
      required(Object.keys(p).length===1, 'Reconciliation accepts an item identity, never caller-supplied outcomes or evidence.');
      return actions.reconcile(p.itemId);
    }
    case 'worker.poll': {
      const workerId = await worker(connection);
      required(canonicalHash(p) === canonicalHash({ mode: 'deterministic', provider: 'none', model: 'none', effort: 'none', billing: 'no-worker-model-calls' }), 'Worker model/provider/billing configuration cannot change.');
      lastWorker = { workerId, at: new Date().toISOString(), mode: p.mode, modelCalls: 0 };
      workerError = null;
      const policy = host.all("SELECT * FROM policies WHERE state='active' ORDER BY issued_at DESC").find(row => { const d = JSON.parse(row.decision_json); return (host.assurance==='production'||d.scope.verificationOnly===true)&&d.controller.controllerId === workerKeys.controllerId && d.controller.publicKey === workerKeys.publicKey && host.status(row.policy_id).valid; });
      if (!policy || host.dispatchBlocked) return { claim: null, reason: policy ? host.dispatchBlocked : 'no_eligible_policy' };
      await actions.flushIncidents(policy.policy_id);
      if (connection.controller?.policyId !== policy.policy_id) {
        const challenge = host.controllerChallenge(policy.policy_id, workerKeys.controllerId);
        const signed = { type: 'deszo.controller.auth', ...challenge };
        const result = host.authenticateController({ nonce: challenge.nonce, signature: sign(null, canonicalBytes(signed), createPrivateKey(workerKeys.privateKey)).toString('base64') });
        connection.controller = { connectionId: result.connectionId, policyId: policy.policy_id }; connection.workerId = workerId;
      }
      const initialPlan=JSON.parse(policy.decision_json).initialPlan;
      if(initialPlan)queue.enqueue({itemId:derivedUuid(policy.policy_id,'signed-initial-plan'),policyId:policy.policy_id,plan:initialPlan},connection.controller.connectionId);
      return { claim: queue.claim(policy.policy_id, workerId, connection.controller.connectionId) };
    }
    case 'worker.execute': {
      const workerId = await worker(connection), row = queue.held(p.itemId, p.lease, workerId);
      required(connection.controller?.policyId === row.policy_id, 'The worker lost policy authority.');
      const step = JSON.parse(row.plan_json).steps[row.step_index]; let result;
      try {
        if (step.type === 'lifecycle.restart' || step.type === 'lifecycle.rollback'||step.type==='lifecycle.verify'||step.type==='lifecycle.stop') {
          if (step.type === 'lifecycle.stop') {
            const registrations = [...host.runtimeRegistrations.entries()].filter(([,r])=>r.policyId===row.policy_id&&r.ready?.buildId===step.args.buildId);
            required(registrations.length===1,'A queued Stop requires one exact ready generation of the selected build.');
            result=await lifecycle.stop({policyId:row.policy_id,requestId:row.step_request_id,runtimeGeneration:registrations[0][0]},connection.controller.connectionId,{itemId:p.itemId});
          } else result = await lifecycle.restart({ connection, policyId: row.policy_id, requestId: row.step_request_id, buildId: step.args.buildId, operation: step.type === 'lifecycle.rollback' ? 'app.rollback' : step.type==='lifecycle.verify'?'app.verify':'app.restart' });
          result = { ...result, outcome: result.outcome === 'verified' ? 'succeeded' : result.outcome === 'blocked' ? 'failed' : result.outcome };
        } else result = await actions.execute({ connection, policyId: row.policy_id, requestId: row.step_request_id, step, itemId: p.itemId,workerId,lease:p.lease });
      }
      catch (error) { const termination = await native('stopDomain', { domain: row.policy_id }); host.audit('worker.incident', { itemId: p.itemId, error: error.message, termination, captureGaps: ['Step outcome requires reconciliation before retry.'] }, { policyId: row.policy_id }); result = { outcome: 'reconciling', reason: `${error.code || 'error'}: ${error.message}`, termination }; }
      if (result.waiting) return { ...queue.wait({ itemId: p.itemId, lease: p.lease, receipt: result }, workerId), watch: result };
      return queue.finish({ itemId: p.itemId, lease: p.lease, result }, workerId);
    }
    case 'worker.watch': { const workerId = await worker(connection); queue.held(p.itemId, p.lease, workerId);
      try { return await actions.watch(p.itemId); }
      catch (error) { const result = await actions.failWatch(p.itemId,error); return { finished: queue.finish({ itemId:p.itemId,lease:p.lease,result },workerId) }; }
    }
    case 'worker.observed': {
      const workerId = await worker(connection); queue.held(p.itemId, p.lease, workerId);
      let result; try { result = await actions.observed(p.itemId, p.observation, workerId); }
      catch (error) { result = await actions.failWatch(p.itemId,error); }
      return result.waiting ? { state: 'waiting', watch: result } : queue.finish({ itemId: p.itemId, lease: p.lease, result }, workerId);
    }
    case 'command.complete': return actions.completeCommand(p, peer);
    case 'status': return host.status(p.policyId);
    case 'session.index': return host.sessionIndex(p.sessionId);
    case 'policy.propose': {
      required(peer?.verifiedByService && peer.userSid === installation.userSid, 'The authorized desktop user is required.');
      required(p.scope?.desktop?.user === installation.userSid && p.scope?.desktop?.sessionId === peer.sessionId, 'The policy must name this actual desktop user/session.');
      return host.proposePolicy(p);
    }
    case 'policy.authorize': throw new HostError(403, 'trusted_consent_required', 'Use the installed Windows Hello broker.');
    case 'consent.overview': broker(peer); return overview();
    case 'consent.launcher_identity': {
      broker(peer);
      required(host.all("SELECT policy_id,decision_json FROM policies WHERE state='active'").some(row=>{const scope=JSON.parse(row.decision_json).scope;return host.status(row.policy_id).valid&&scope.desktop.user===peer.userSid&&scope.desktop.sessionId===peer.sessionId;}),'Foreground handoff needs an already authorized live desktop session.');
      return {launcher:await native('launcherIdentity')};
    }
    case 'consent.enrollment.begin': return consent.enrollmentBegin(peer);
    case 'consent.enrollment.prepare': return consent.enrollmentPrepare(p, peer);
    case 'consent.enrollment.finish': return consent.enrollmentFinish(p, peer);
    case 'consent.policy.challenge': {
      const result = consent.policyChallenge(p, peer); return { ...result, displayText: JSON.stringify(result.decision, null, 2) };
    }
    case 'consent.policy.authorize': return consent.authorizePolicy(p, peer);
    case 'consent.policy.receipt': return consent.receipt(p, peer);
    case 'consent.retirement.begin': return consent.retirementBegin(peer);
    case 'consent.retirement.finish': return consent.retirementFinish(p, peer);
    case 'consent.revoke': broker(peer); return host.revoke(p.policyId, { actor: `verified broker user ${peer.userSid}` });
    case 'controller.challenge': return host.controllerChallenge(p.policyId, p.controllerId);
    case 'controller.authenticate': {
      const result = host.authenticateController(p); connection.controller = { connectionId: result.connectionId, policyId: host.controllerConnections.get(result.connectionId).policyId }; return { authenticated: true, policyId: connection.controller.policyId };
    }
    case 'decide': required(p.request?.operation !== 'runtime.reregister', 'Runtime recovery must use independently verified native registration, not an ordinary decision request.'); return host.decide(p.request, { connectionId: connection.controller?.connectionId, runtime: connection.runtime });
    case 'runtime.register_initial': {
      // Ordinary applications cannot self-attest an initial production runtime. Use a contained host launch.
      throw new HostError(403, 'contained_launch_required', 'A native host launch is required for an autonomous runtime.');
    }
    case 'runtime.context': return native('runtimeContext', { pid: peer.parent.pid });
    case 'runtime.reregister': {
      const result = await reregisterInstalledRuntime({ host, installation, native, lifecycle, peer, policyId: p.policyId });
      connection.runtime = { policyId: p.policyId, runtimeGeneration: result.runtimeGeneration }; return result;
    }
    case 'runtime.register': {
      const actual = peer.parent;
      required(peer.nativeMode === 'client' && actual?.imageSha256 === installation.files['node.exe'], 'The runtime must use the pinned Node executable.');
      const desktop = JSON.parse(host.policyRow(p.policyId).decision_json).scope.desktop;
      required(!actual.administratorMember && actual.userSid === desktop.user && actual.sessionId === desktop.sessionId, 'The runtime token or desktop differs from consent.');
      let operation = host.operationRow(p.operationId);
      const deadline = Date.now() + 5000;
      while (operation.phase === 'launch_requested' && operation.outcome === 'in_progress' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 25)); operation = host.operationRow(p.operationId); }
      const evidence = JSON.parse(operation.evidence_json);
      required(operation.policy_id === p.policyId && evidence.launch, 'No observed launch is awaiting this runtime.');
      await lifecycle.validateRuntimeSource(operation, peer);
      const contained = await native('contains', { domain: p.policyId, pid: actual.pid });
      required(contained.contained, 'The runtime is outside the service-owned Job.');
      let ancestor = actual, matched = sameProcess(ancestor, evidence.launch);
      for (let depth = 0; !matched && ancestor.parentPid && depth < 8; depth++) { const child = ancestor; ancestor = await native('inspect', { pid: ancestor.parentPid }); required(BigInt(ancestor.creationTime) <= BigInt(child.creationTime), 'An ancestor PID was reused.'); matched = sameProcess(ancestor, evidence.launch); }
      required(matched, 'The runtime is not a descendant of the selected application.');
      // The root launch proof is now bound to the independently observed, contained runtime descendant.
      host.transaction(() => {
        host.run("UPDATE registration_proofs SET expected_json = ? WHERE operation_id = ? AND consumed_at IS NULL", canonicalize(actual), p.operationId);
        host.audit('runtime.descendant_bound', { operationId: p.operationId, root: evidence.launch, runtime: actual }, { policyId: p.policyId });
      });
      const result = host.registerRuntime({ ...p, processEvidence: actual, peerEvidence: actual });
      connection.runtime = { policyId: p.policyId, runtimeGeneration: result.runtimeGeneration }; return result;
    }
    case 'runtime.attach': {
      const registration = host.runtimeRegistrations.get(p.runtimeGeneration);
      required(registration && sameProcess(registration.processEvidence, peer.parent), 'The connection belongs to another OS process.');
      const result = host.attachRuntime(p); connection.runtime = { policyId: p.policyId, runtimeGeneration: p.runtimeGeneration }; return result;
    }
    case 'runtime.ready': return lifecycle.recordReady(p, connection);
    case 'application.launcher_identity': {
      required(peer.verifiedByService&&peer.nativeMode==='client'&&Object.keys(p).length===1&&host.launchedByHost(p.policyId,peer.parent),'Only the actual host-launched application may select the trusted launcher for foreground handoff.');
      const desktop=JSON.parse(host.policyRow(p.policyId).decision_json).scope.desktop;
      required(peer.parent.userSid===desktop.user&&peer.parent.sessionId===desktop.sessionId&&!peer.parent.administratorMember,'Foreground handoff belongs to another desktop or privileged process.');
      required((await native('contains',{domain:p.policyId,pid:peer.parent.pid})).contained,'The closing application is outside its owned domain.');
      return {applicationPid:peer.parent.pid,launcher:await native('launcherIdentity')};
    }
    case 'lifecycle.stop': return lifecycle.stop(p, connection.controller?.connectionId);
    case 'lifecycle.restart': return lifecycle.restart({ connection, policyId: p.policyId, requestId: p.requestId, buildId: p.buildId });
    case 'lifecycle.rollback': return lifecycle.restart({ connection, policyId: p.policyId, requestId: p.requestId, buildId: p.buildId, operation: 'app.rollback' });
    case 'lifecycle.verify': return lifecycle.restart({ connection, policyId: p.policyId, requestId: p.requestId, buildId: p.buildId, operation: 'app.verify' });
    case 'installation.build.stage': operator(peer); return lifecycle.builds.stage({ ...p, operatorBaseline: true });
    case 'installation.source.inspect': operator(peer); return lifecycle.builds.inspectSource(p.sourceRoot);
    case 'installation.runtime.inspect': {
      operator(peer); return [...host.runtimeRegistrations.entries()].filter(([,r])=>!p.policyId||r.policyId===p.policyId).map(([runtimeGeneration,r])=>({runtimeGeneration,policyId:r.policyId,operationId:r.operationId,verificationOnly:r.verificationOnly===true,process:r.processEvidence,ready:r.ready??null}));
    }
    case 'installation.desktop.status': operator(peer); return native('desktopStatus');
    case 'installation.diagnostic.enqueue': {
      operator(peer);const decision=JSON.parse(host.policyRow(p.policyId).decision_json),build=lifecycle.builds.get(p.buildId);
      required(decision.scope.verificationOnly===true&&decision.controller.controllerId===workerKeys.controllerId&&decision.controller.publicKey===workerKeys.publicKey&&build.verification.diagnosticOnly===true,'Only a sealed diagnostic build under the existing verification-only worker policy can be queued here.');
      const workerConnection=[...connections.values()].find(c=>c.workerId&&c.controller?.policyId===p.policyId);
      required(workerConnection&&lastWorker&&Date.now()-Date.parse(lastWorker.at)<10000,'The actual scoped installed worker must be connected.');
      const plan=p.plan??{schemaVersion:1,kind:'ControllerPlan',mode:'deterministic',steps:[{type:'lifecycle.verify',args:{buildId:p.buildId,requireUi:true}}]};
      required(Array.isArray(plan.steps)&&plan.steps.every(step=>['lifecycle.verify','lifecycle.stop'].includes(step.type)&&step.args?.buildId===p.buildId),'Diagnostic plans must use the one exact sealed build.');
      return queue.enqueue({itemId:p.requestId,policyId:p.policyId,plan},workerConnection.controller.connectionId);
    }
    case 'installation.runtime.restart_probe': {
      operator(peer);const registration=host.runtimeRegistrations.get(p.runtimeGeneration);
      required(registration?.verificationOnly===true&&JSON.parse(host.policyRow(registration.policyId).decision_json).scope.verificationOnly===true,'This native diagnostic may terminate only its own verification-only Node runtime.');
      required(host.operationRow(registration.operationId).outcome==='verified'&&!host.get("SELECT work_id FROM active_work WHERE policy_id=? AND state='active'",registration.policyId),'Wait for verified idle application startup.');
      const before=host.status(registration.policyId),termination=await native('terminateRuntime',{domain:registration.policyId,process:registration.processEvidence});
      const end=Date.now()+30000;let replacement;
      do{replacement=[...host.runtimeRegistrations.entries()].find(([generation,r])=>generation!==p.runtimeGeneration&&r.policyId===registration.policyId&&r.operationId===registration.operationId&&r.ready);if(replacement)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);
      const after=host.status(registration.policyId),passed=Boolean(replacement)&&!host.runtimeRegistrations.has(p.runtimeGeneration)&&after.expiresAt===before.expiresAt&&after.used.restarts===before.used.restarts+1;
      const result={passed,policyId:registration.policyId,oldGeneration:p.runtimeGeneration,newGeneration:replacement?.[0]??null,previousProcess:registration.processEvidence,process:replacement?.[1].processEvidence??null,termination,before,after};
      host.audit('installation.runtime_restart_probe',result,{policyId:registration.policyId});return result;
    }
    case 'installation.profile.register': operator(peer); return lifecycle.registerProfile(p, peer);
    case 'installation.profile.fork': operator(peer); return lifecycle.profiles.fork(p);
    case 'permit.request': { const permit = host.permitRequest(p.permitId); party(connection, permit); return permit; }
    case 'permit.validate': party(connection,host.permitRequest(p.permitId));return host.validatePermit(p.permitId);
    case 'admit': party(connection, host.permitRequest(p.permitId)); return host.admit(p.permitId);
    case 'settle': party(connection, host.permitRequest(p.permitId)); return host.settle(p.permitId, p);
    case 'work.release': party(connection, host.permitRequest(p.permitId)); return host.releaseWork(p.permitId, p.workRef, { evidence: p.evidence });
    case 'revoke': required(connection.controller, 'An authenticated controller is required.'); return host.revoke(p.policyId, { actor: 'authenticated controller', connectionId: connection.controller.connectionId });
    case 'operation.reconcile': {
      required(connection.controller, 'An authenticated controller is required.'); const op=host.operationRow(p.operationId); host.requireController(connection.controller.connectionId,op.policy_id);
      required(Object.keys(p).length===1 && op.outcome==='reconciling', 'Use the fixed native reconciliation procedure; supplied success claims cannot resolve an operation.');
      await reconcileStoppedPolicy({host,native,policyId:op.policy_id}); return {operationId:p.operationId,outcome:host.operationRow(p.operationId).outcome};
    }
    case 'installation.status': operator(peer); return { ...overview(), native: await native('health'), sourceDigest: enablement.sourceDigest, sourceFingerprintVersion:2, installationId: installation.installationId };
    case 'installation.capability.record': operator(peer); return enablement.record(p);
    case 'installation.activate': {
      operator(peer); const health = await native('health');
      required(health.launcherConnected && consent.credential() && lastWorker && Date.now() - Date.parse(lastWorker.at) < 10000, 'Native launcher, verified enrollment and the restricted worker must be live.');
      return enablement.enable();
    }
    case 'installation.probe': {
      operator(peer); const result = await native('probeLaunch', p);
      host.audit('installation.native_probe', { testId: p.testId, kind: p.kind, result }); return result;
    }
    case 'installation.probe.inspect': operator(peer); return native('probeInspect', p);
    case 'installation.probe.security': operator(peer); return native('probeSecurity');
    case 'installation.probe.stopRoot': {
      operator(peer); required(/^[0-9a-f-]{36}$/.test(p.testId), 'A diagnostic UUID is required.');
      return native('stopProcess', { domain: `probe:${p.testId}`, process: p.process });
    }
    case 'installation.probe.stop': {
      operator(peer); required(/^[0-9a-f-]{36}$/.test(p.testId), 'A diagnostic UUID is required.');
      return native('stopDomain', { domain: `probe:${p.testId}` });
    }
    default: throw new HostError(404, 'unknown_method', 'Unknown protected-host method.');
  }
}
function initialize(packet) {
  if (host) throw new Error('The service channel was already initialized.');
  installation = packet.installation;
  const root = resolve(import.meta.dirname), configured = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'));
  if (canonicalHash(configured) !== canonicalHash(installation) || resolve(process.execPath).toLowerCase() !== resolve(root, 'node.exe').toLowerCase()) throw new Error('The protected installation binding differs.');
  const result = spawnSync(join(root, 'deszo-control.exe'), ['inspect', String(process.ppid)], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0) throw new Error(`Cannot verify the service parent: ${result.stderr}`);
  const parent = JSON.parse(result.stdout);
  if (parent.userSid !== 'S-1-5-19' || parent.imageSha256 !== installation.files['deszo-control.exe'] || !sameProcess(parent, packet.service)) throw new Error('The parent is not the installed LocalService authority.');
  host = new ControlHost({ root: installation.stateRoot, assurance: 'bootstrap', recover: false });
  host.acquireOwnership(); host.recover();
  consent = new WebAuthnConsent({ host, requireBroker: broker });
  lifecycle = installedLifecycle({ host, installation, native, installRoot: root });
  queue = new ControllerQueue({ host }); queue.recover();
  actions = installedActions({ host, installation, native, queue, installRoot: root });
  enablement = new InstalledEnablement({ host, installation }); enablement.restore();
  const storedWorker = host.get("SELECT value FROM host_meta WHERE key='installed_worker_identity'");
  if (storedWorker) workerKeys = JSON.parse(storedWorker.value);
  else {
    const keys = generateKeyPairSync('ed25519');
    workerKeys = { controllerId: `installed-worker:${installation.installationId}`, publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
    host.run("INSERT INTO host_meta(key,value) VALUES('installed_worker_identity',?)", canonicalize(workerKeys));
  }
  // Infrastructure recovery only: the service does not choose workflow stages, roles or queue content.
  const ensureWorker = () => native('workerStart').catch(error => { workerError = error.message; });
  void ensureWorker(); setInterval(ensureWorker, 5000).unref();
  const attemptedReconciliations=new Set();let reconcilingQueue=false;
  const reconcileQueue=async()=>{
    if(reconcilingQueue)return;reconcilingQueue=true;
    try{for(const row of host.all("SELECT item_id,policy_id FROM controller_queue WHERE state='reconciling' ORDER BY created_at")){
      if(attemptedReconciliations.has(row.item_id))continue;attemptedReconciliations.add(row.item_id);
      try{await actions.reconcile(row.item_id);}catch(error){host.audit('worker.reconciliation_blocked',{itemId:row.item_id,reason:error.message},{policyId:row.policy_id});}
    }}finally{reconcilingQueue=false;}
  };
  // Infrastructure reconciliation only establishes native interruption. It neither resubmits a step nor chooses roles.
  void reconcileQueue();setInterval(()=>void reconcileQueue(),5000).unref();
  host.onStop = (permits, works, scope = {}) => {
    const policies = new Set(scope.policyIds || []); for (const id of permits) policies.add(host.permitView(id).policy_id); for (const work of works || []) policies.add(work.policyId ?? host.get('SELECT policy_id FROM active_work WHERE work_ref = ?', work.workRef)?.policy_id);
    for (const policyId of policies) if (policyId) native('stopDomain', { domain: policyId }).catch(error => { host.dispatchBlocked = error.message; });
    for (const [connectionId, connection] of connections) if (connection.runtime) answer(connectionId, { event: 'stop', permits, works: (works || []).map(w => w.workRef) });
  };
  setInterval(() => host.enforceExpiry(), 500).unref();
  writeFileSync(join(installation.stateRoot, 'service-ready.json'), JSON.stringify({ hostInstance: host.hostInstance, pid: process.pid, servicePid: parent.pid, assurance: host.assurance, sourceDigest: canonicalHash(installation.files), at: new Date().toISOString() }));
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Service frame exceeds its bound.');
    const packet = parseStrictJson(line);
    if (packet.kind === 'initialize') return initialize(packet);
    if (!host) throw new Error('Service initialization is required.');
    if (packet.kind === 'nativeResult') {
      const item = pending.get(packet.message.id); if (!item) return; pending.delete(packet.message.id); clearTimeout(item.timer);
      if (packet.message.error) item.reject(Object.assign(new Error(packet.message.error.message), packet.message.error)); else item.resolve(packet.message.result); return;
    }
    if (packet.kind === 'connect') { connections.set(packet.connectionId, { peer: packet.peer, queue: Promise.resolve() }); return; }
    const connection = connections.get(packet.connectionId);
    if (packet.kind === 'disconnect') {
      if (connection?.workerId) { queue.recover('registered worker connection lost; native effects require reconciliation'); native('stopDomain', { domain: connection.controller.policyId }).catch(() => {}); }
      if (connection?.controller) host.controllerConnections.delete(connection.controller.connectionId);
      connections.delete(packet.connectionId); return;
    }
    if (!connection || packet.kind !== 'request') throw new Error('Unknown native connection.');
    connection.queue = connection.queue.then(async () => {
      try { answer(packet.connectionId, { id: packet.message.id, result: await route(connection, packet.message) }); }
      catch (error) { if (packet.message.method.startsWith('worker.')) workerError = error.message; answer(packet.connectionId, { id: packet.message.id, error: { status: error.status || 500, code: error.code || 'host_error', message: error.message } }); }
    });
  } catch (error) { process.stderr.write(`Protected service protocol: ${error.message}\n`); process.exit(74); }
});
input.on('close', () => { host?.close(); process.exit(0); });
