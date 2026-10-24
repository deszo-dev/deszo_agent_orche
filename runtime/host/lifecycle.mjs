// Build manifests and the phased application restart of ADR-0006 section 5.
//
// The restart is a durable host operation. The host decides the exact target first (profile, build root, application
// mode, desktop and the process it would stop); a mismatch is refused before anything is stopped or launched. Each phase
// records its evidence. A launch uses a one-time registration proof that the host issues and only the observed process
// may redeem. Every external call is bounded; an exception, timeout or lost reply after an effect may have started is
// persisted as reconciling, which blocks dispatch and is never retried blindly.
//
// The launcher, inspector, health and UI checks are injected: the protected Task Scheduler launcher and native Windows
// inspector are not part of this module (see the ADR-0006 implementation status).
//
// Known limit: hashing a build directory and launching from it later leaves a window in which a same-user process
// could replace a file. The inspector re-hashes the image of the process actually created, which detects a replaced
// executable but not a replaced resource loaded later. Locking the build against writes is a gate.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalHash } from '../core/canonical.mjs';
import { check } from '../core/schemas.mjs';
import { HostError } from './authority.mjs';

function filesUnder(root) {
  if (lstatSync(root).isSymbolicLink() || resolve(realpathSync(root)).toLowerCase() !== resolve(root).toLowerCase()) throw new HostError(403, 'unsafe_build_path', 'Build roots cannot traverse symbolic links or junctions.');
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new HostError(403, 'unsafe_build_path', 'Build artifacts cannot contain symbolic links or junctions.');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

const fileDigest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function createBuildManifest({ buildDir, buildId, sourceCommit, dirtySourceDigest = null, inputsDigest, protocolVersion, storeSchemaVersion, launchEntry, createdAt }) {
  const root = resolve(buildDir);
  const artifacts = filesUnder(root).map(path => ({ path: relative(root, path).split(sep).join('/'), sha256: fileDigest(path), bytes: statSync(path).size }));
  const manifest = { schemaVersion: 1, kind: 'BuildManifest', buildId, sourceCommit, dirtySourceDigest, inputsDigest, protocolVersion, storeSchemaVersion, launchEntry, artifacts, createdAt };
  const issues = check('autonomy-policy.schema.json', 'buildManifest', manifest);
  if (issues.length) throw new HostError(400, 'invalid_request', `Build manifest violates its contract: ${issues.map(i => i.message).join('; ')}`);
  if (!artifacts.some(a => a.path === launchEntry)) throw new HostError(400, 'invalid_request', 'The launch entry is not one of the manifest artifacts.');
  return manifest;
}

// Recomputes every artifact. Missing, changed and unlisted files all fail verification.
export function verifyBuildDirectory(manifest, buildDir) {
  const root = resolve(buildDir);
  const present = new Map(filesUnder(root).map(path => [relative(root, path).split(sep).join('/'), path]));
  const problems = [];
  for (const artifact of manifest.artifacts) {
    const path = present.get(artifact.path);
    if (!path) problems.push(`missing ${artifact.path}`);
    else if (fileDigest(path) !== artifact.sha256) problems.push(`changed ${artifact.path}`);
    present.delete(artifact.path);
  }
  for (const extra of present.keys()) problems.push(`unlisted ${extra}`);
  return { verified: problems.length === 0, problems, manifestDigest: canonicalHash(manifest) };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

export class ApplicationLifecycle {
  constructor({ host, launcher, inspector, healthCheck, uiCheck = null, pollMs = 25, phaseTimeoutMs = 30_000 }) {
    Object.assign(this, { host, launcher, inspector, healthCheck, uiCheck, pollMs, phaseTimeoutMs });
  }

  // Every external call is bounded. A call that outlives its bound may still complete; the caller treats it as ambiguous.
  async bounded(label, call) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HostError(504, 'phase_timeout', `${label} did not finish within ${this.phaseTimeoutMs} ms.`)), this.phaseTimeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(call), timeout]); }
    finally { clearTimeout(timer); }
  }

  // Stop, then native proof that the process ended. Returns true only with that proof.
  async stopAndConfirm(process) {
    // The native stop reports whether its whole owned domain is empty; a fixture launcher reports nothing.
    const stop = await this.bounded('stop', () => this.launcher.stop(process));
    if (stop?.domainEmpty === false) return false;
    return this.bounded('termination check', async () => {
      const end=Date.now()+Math.min(5000,this.phaseTimeoutMs);
      do { if((await this.inspector.isRunning(process))===false)return true; await sleep(this.pollMs); } while(Date.now()<end);
      return false;
    });
  }

  // Performs one authorized restart. Returns { outcome, reason, operationId, runtimeGeneration } where outcome is one of
  // blocked (refused, nothing started), reconciling (an effect may have happened), failed (established failure) or verified.
  async restart({ connectionId, policyId, requestId, buildRoot, buildDir, manifest, profile, applicationMode, desktop, currentProcess = null, rationale, operation = 'app.restart',
    startupDeadlineMs = 30_000, requireUi = false, justification }) {
    const target = { profile, applicationMode, desktop, buildRoot, buildDir: resolve(buildDir), buildId: manifest.buildId,
      currentProcess: currentProcess ? { pid: currentProcess.pid, creationTime: currentProcess.creationTime } : null };
    if (!['app.restart', 'app.rollback','app.verify'].includes(operation)) throw new HostError(400, 'invalid_request', 'Only restart, compatible rollback or consented native verification is supported.');
    if(operation==='app.verify'&&!requireUi)throw new HostError(400,'native_ui_required','Native verification cannot omit the application UI evidence.');
    const receipt = this.host.decide({ requestId, policyId, operation, cost: {}, justification: justification ?? rationale, target }, { connectionId });
    if (receipt.outcome !== 'approved') return { outcome: 'blocked', reason: `authority: ${receipt.reason}`, operationId: null, runtimeGeneration: null };
    const admission = this.host.admit(receipt.permitId);
    if (!admission.admitted) {
      this.host.settle(receipt.permitId, { effect: 'not_executed', evidence: `admission refused: ${admission.reason}` });
      return { outcome: 'blocked', reason: `authority: ${admission.reason}`, operationId: null, runtimeGeneration: null };
    }
    let identity;
    try { identity = verifyBuildDirectory(manifest, buildDir); }
    catch (error) {
      this.host.settle(receipt.permitId, { effect: 'not_executed', evidence: `build unreadable: ${error.message}` });
      return { outcome: 'blocked', reason: 'build_unreadable', operationId: null, runtimeGeneration: null };
    }
    let operationId;
    try {
      ({ operationId } = this.host.beginOperation({ permitId: receipt.permitId, kind: operation,
        intent: { buildId: manifest.buildId, buildDir: resolve(buildDir), manifestDigest: identity.manifestDigest, profile, applicationMode, rationale, expectedCurrent: currentProcess,
          recovery: 'last verified build; data restore only with a profile-specific compatible plan' } }));
    } catch (error) {
      this.host.settle(receipt.permitId, { effect: 'not_executed', evidence: `lifecycle intent refused: ${error.message}` });
      return { outcome: 'blocked', reason: error.code || 'intent_refused', operationId: null, runtimeGeneration: null };
    }
    const blocked = (reason, effect, evidence = {}) => {
      this.host.finishOperation(operationId, { outcome: 'blocked', reason, evidence });
      this.host.settle(receipt.permitId, { effect, evidence: reason });
      return { outcome: 'blocked', reason, operationId, runtimeGeneration: null };
    };
    // Ambiguous: an external effect may have started. Persist it as reconciling; no retry is attempted here.
    const ambiguous = (reason, evidence = {}) => {
      this.host.finishOperation(operationId, { outcome: 'reconciling', reason, evidence: { ...evidence, ambiguous: true } });
      this.host.settle(receipt.permitId, { effect: 'unknown', evidence: reason });
      return { outcome: 'reconciling', reason, operationId, runtimeGeneration: null };
    };

    try {
      // 1. The build must match its manifest before anything is stopped.
      if (!identity.verified) return blocked('unverified_build_identity', 'not_executed', { buildCheck: identity });
      this.host.recordPhase(operationId, 'build_verified', { buildCheck: identity });

      // 2. Quiesce: stop the old application and require native proof that it ended.
      if (currentProcess) {
        // A stop that completed while the process is still alive is an established failure to end it; a stop that threw or timed out is ambiguous (above).
        if (!(await this.stopAndConfirm(currentProcess))) return blocked('unconfirmed_termination', 'consumed', { stop: { process: currentProcess, alive: true } });
        this.host.recordPhase(operationId, 'old_terminated', { stop: { process: currentProcess, alive: false } });
      }

      // 3. Launch the exact build. The registration proof is issued now and only the observed process may redeem it.
      const { registrationNonce } = this.host.issueLaunchProof(operationId);
      const launchPath = join(resolve(buildDir), manifest.launchEntry);
      const started = await this.bounded('launch', () => this.launcher.start({ operationId, launchPath, profile, registrationNonce }));
      const observed = await this.bounded('inspection', () => this.inspector.describe(started.pid));
      const entry = manifest.artifacts.find(a => a.path === manifest.launchEntry);
      const identityOk = Boolean(observed) && resolve(observed.imagePath) === launchPath && observed.imageSha256 === entry.sha256 && observed.sessionId === desktop.sessionId;
      if (!identityOk) {
        if (!observed) return ambiguous('launched_process_not_observed', { launch: { pid: started.pid, observed: false } });
        if (!(await this.stopAndConfirm(observed))) return ambiguous('unverified_build_identity_and_termination_unconfirmed', { launch: observed });
        return blocked('unverified_build_identity', 'consumed', { launch: observed });
      }
      this.host.bindLaunch(operationId, observed);

      // 4. The new runtime must redeem the proof, which binds its generation to the observed process.
      const deadline = Date.now() + startupDeadlineMs;
      let registration = null;
      while (!registration && Date.now() < deadline) {
        registration = [...this.host.runtimeRegistrations.entries()].find(([, r]) => r.operationId === operationId) ?? null;
        if (!registration) await sleep(this.pollMs);
      }
      if (!registration) {
        if (!(await this.stopAndConfirm(observed))) return ambiguous('runtime_not_authenticated_and_termination_unconfirmed', { launch: observed });
        return blocked('runtime_not_authenticated', 'consumed', { launch: observed, stopped: true });
      }
      const [runtimeGeneration] = registration;
      this.host.recordPhase(operationId, 'runtime_registered', { runtimeGeneration });

      // 5. Health and, where required, native UI evidence against this generation.
      const health = await this.bounded('health check', () => this.healthCheck({ runtimeGeneration, process: observed }));
      const healthy = health?.ok && health.buildId === manifest.buildId && health.protocolVersion === manifest.protocolVersion && health.storeSchemaVersion === manifest.storeSchemaVersion;
      if (!healthy) {
        this.host.retireRuntime(runtimeGeneration, 'health_or_identity_mismatch');
        if (!(await this.stopAndConfirm(observed))) return ambiguous('health_or_identity_mismatch_and_termination_unconfirmed', { health });
        this.host.finishOperation(operationId, { outcome: 'failed', reason: 'health_or_identity_mismatch', evidence: { health, stopped: true } });
        this.host.settle(receipt.permitId, { effect: 'consumed', evidence: 'launched build failed verification' });
        return { outcome: 'failed', reason: 'health_or_identity_mismatch', operationId, runtimeGeneration };
      }
      let ui = null;
      if (requireUi) {
        ui = this.uiCheck ? await this.bounded('UI check', () => this.uiCheck({ runtimeGeneration, process: observed })) : null;
        if (!ui?.available) { this.host.retireRuntime(runtimeGeneration, 'ui_evidence_unavailable'); if(!(await this.stopAndConfirm(observed)))return ambiguous('ui_unavailable_and_termination_unconfirmed',{ui}); return blocked('ui_evidence_unavailable', 'consumed', { ui,stopped:true }); }
        if (ui.pid !== observed.pid || ui.runtimeGeneration !== runtimeGeneration) { this.host.retireRuntime(runtimeGeneration, 'ui_evidence_not_bound'); if(!(await this.stopAndConfirm(observed)))return ambiguous('ui_identity_mismatch_and_termination_unconfirmed',{ui}); return blocked('ui_evidence_not_bound', 'consumed', { ui,stopped:true }); }
      }

      // 6. Verified only with the whole evidence chain.
      this.host.finishOperation(operationId, { outcome: 'verified', evidence: { health, ui, verification: { complete: true, chain: ['manifest', 'artifact_digests', 'os_process', 'runtime_generation', 'protocol_and_store'] } } });
      this.host.settle(receipt.permitId, { effect: 'consumed', evidence: 'restart verified' });
      return { outcome: 'verified', reason: null, operationId, runtimeGeneration };
    } catch (error) {
      // An exception after the operation began is never reported as a clean refusal: the effect state is unknown.
      return ambiguous(`lifecycle exception: ${error.code || 'error'}: ${error.message}`);
    }
  }
}
