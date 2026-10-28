// Local Control Host authority core (ADR-0006 sections 2, 4 and 6).
//
// This module is the policy, admission and ledger logic that the protected Windows service hosts. It owns its own
// database outside the replaceable application and enforces the outer authority of an autonomous development
// session: consent-bound policy creation, same-boot expiry, revocation fencing, serialized budget reservation,
// admission permits, durable operations, active-work ownership and startup reconciliation. The Deszo engine keeps its
// own workflow validation; a host approval never replaces it, and the engine can never widen a host decision.
//
// What this module does not provide (see the ADR-0006 implementation status and capabilities.mjs): the Windows service
// wrapper and its service-SID ACLs, the Task Scheduler launcher, the Windows consent broker and protected display,
// native named-pipe peer verification and cross-user Job ownership. Production assurance refuses to start while those
// capabilities are unverified; fixture assurance exercises the same logic with injected components.
import { DatabaseSync } from 'node:sqlite';
import { createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalBytes, canonicalHash, canonicalize, sha256 } from '../core/canonical.mjs';
import { check } from '../core/schemas.mjs';
import { ASSURANCE_LEVELS, missingProductionCapabilities } from './capabilities.mjs';
import { remainingAuthority, systemTimeSource } from './timeSource.mjs';
import { validateControllerPlan } from './controllerQueue.mjs';

const MIGRATION_FILES = ['host-h1.sql', 'host-h2.sql', 'host-h3.sql', 'host-h4.sql', 'host-h5.sql'];
const migrationUrl = name => (existsSync(new URL(`./${name}`, import.meta.url)) ? new URL(`./${name}`, import.meta.url) : new URL(`../../docs/storage/${name}`, import.meta.url));
export const HOST_MIGRATIONS = MIGRATION_FILES.map(migrationUrl);
const SCHEMA = 'autonomy-policy.schema.json';
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const GENESIS = '0'.repeat(64);
export const BUDGET_KEYS = ['attempts', 'providerInvocations', 'workerModelCalls', 'operations', 'restarts', 'repairs', 'builds'];
// The operation a host-bound runtime requests for each provider (agent CLI) invocation, including retries and context continuation.
export const PROVIDER_OPERATION = 'provider.invoke';

// The minimum charge of each operation. A caller may declare more, never less; every operation counts once. A run
// counts one attempt when it is created; each provider invocation of its attempts is charged separately.
const MINIMUM_COST = {
  'run.approve': { attempts: 1 },
  'supervision.approve': {},
  'run.stop_and_report': {},
  'run.retry': { attempts: 1 },
  'check.run': {},
  'build.run': { builds: 1 },
  'repair.run': { repairs: 1, attempts: 1 },
  'delivery.local': {},
  'app.stop': {},
  'app.start': { restarts: 1 },
  'app.restart': { restarts: 1 },
  'app.rollback': { restarts: 1 },
  'app.verify': { restarts: 1 },
  'runtime.reregister': { restarts: 1 },
  'worker.model_call': { workerModelCalls: 1 },
  [PROVIDER_OPERATION]: { providerInvocations: 1 },
};
const NEEDS_WORKFLOW = new Set(['run.approve', 'supervision.approve', 'run.retry', 'repair.run', PROVIDER_OPERATION]);
const NEEDS_RUNTIME = new Set(['run.approve', 'supervision.approve', 'run.retry', 'repair.run', 'runtime.reregister', PROVIDER_OPERATION]);
const NEEDS_COMMAND = new Set(['check.run', 'build.run']);
const TARGET_OPERATIONS = new Set(['app.start', 'app.restart', 'app.rollback', 'app.stop', 'app.verify', 'runtime.reregister']);
const VERIFICATION_OPERATIONS=new Set(['app.verify','app.stop','runtime.reregister','run.stop_and_report']);
// Requests a registered runtime may make for itself. Everything else needs the authenticated controller.
const RUNTIME_REQUESTABLE = new Set([PROVIDER_OPERATION, 'repair.run', 'runtime.reregister']);
// Stop, evidence and reconciliation stay available when dispatch is blocked; they start no new work.
const FAIL_CLOSED_EXEMPT = new Set(['run.stop_and_report']);

export class HostError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function preserveCleanupFailure(primaryError, cleanupError) {
  const diagnostic = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
  try {
    const existing = Array.isArray(primaryError?.cleanupErrors) ? primaryError.cleanupErrors : [];
    Object.defineProperty(primaryError, 'cleanupErrors', { value: [...existing, diagnostic], configurable: true, enumerable: false });
  } catch {
    try { process.emitWarning(`ControlHost initialization cleanup failed: ${diagnostic.message}`, { code: 'CONTROL_HOST_INIT_CLEANUP_FAILED' }); } catch { /* preserve the primary initialization error */ }
  }
}

const nowIsoFrom = time => new Date(time.wallNow()).toISOString();

function contract(definition, value, label = definition) {
  const issues = check(SCHEMA, definition, value);
  if (issues.length) throw new HostError(400, 'invalid_request', `${label} violates its contract: ${issues.map(i => `${i.path} ${i.message}`).join('; ')}`);
  return value;
}

function publicKeyFrom(encoded) {
  try { return createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' }); }
  catch { throw new HostError(400, 'invalid_request', 'The public key is not a DER SPKI key in base64.'); }
}

function signatureValid(publicKey, value, signature) {
  try { return verifySignature(null, canonicalBytes(value), publicKeyFrom(publicKey), Buffer.from(signature, 'base64')); }
  catch { return false; }
}

// Same process identity: OS process ID, creation time and, when both sides state it, the executable digest.
export function sameProcess(expected, observed) {
  if (!expected || !observed) return false;
  if (expected.pid !== observed.pid || expected.creationTime !== observed.creationTime) return false;
  return observed.imageSha256 === undefined || observed.imageSha256 === null || expected.imageSha256 === observed.imageSha256;
}

function insideRoot(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sameDesktop(target, scope) {
  return Boolean(target && scope) && target.user === scope.user && target.sessionId === scope.sessionId;
}

function digestsEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string' || hexA.length !== hexB.length) return false;
  return timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

const zeroCost = () => Object.fromEntries(BUDGET_KEYS.map(key => [key, 0]));

export class ControlHost {
  // readOnly: an observational view of the store. It never recovers, migrates, takes ownership or writes; it is what
  // `status` uses when no live host answers. recover: a writable host reconciles its store on construction.
  // assurance: 'production' refuses to start while any enablement capability is unverified (fail closed in code).
  constructor({ root, time = systemTimeSource(), audience = 'deszo-local-control-host', hostInstance = randomUUID(), onStop = null, readOnly = false, recover = true, assurance = 'fixture' } = {}) {
    if (!root) throw new Error('ControlHost needs a protected state directory.');
    if (!ASSURANCE_LEVELS.includes(assurance)) throw new Error(`Unknown assurance level ${assurance}.`);
    if (assurance === 'production' && !readOnly) {
      const missing = missingProductionCapabilities();
      if (missing.length) throw new HostError(503, 'autonomy_disabled', `Production autonomy is disabled until these capabilities are verified: ${missing.join(', ')}.`);
    }
    this.root = root;
    this.time = time;
    this.audience = audience;
    this.hostInstance = hostInstance;
    this.onStop = onStop;
    this.assurance = assurance;
    this.readOnly = readOnly;
    this.ownerPath = null;
    // Live connections and registrations exist only in memory: a restart invalidates every one of them.
    this.controllerChallenges = new Map();
    this.controllerConnections = new Map();
    this.runtimeRegistrations = new Map();
    this.closedBarriers = new Set();
    this.auditBroken = null;
    this.revocationFailure = null;
    this.dispatchBlocked = null;
    this.userSurfaceSha256 = null;
    this.db = null;
    try {
      if (readOnly) {
        if (!existsSync(join(root, 'host.sqlite'))) throw new HostError(404, 'not_found', 'No host store exists at this state directory.');
        this.db = new DatabaseSync(join(root, 'host.sqlite'), { readOnly: true });
        this.refreshBlock();
        return;
      }
      mkdirSync(root, { recursive: true });
      this.db = new DatabaseSync(join(root, 'host.sqlite'));
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      this.migrate();
      // A store records the assurance it was created with; fixture state can never be opened as production state.
      const marked = this.get(`SELECT value FROM host_meta WHERE key = 'assurance'`);
      const storeAssurance = assurance === 'bootstrap' ? 'production' : assurance;
      if (!marked) this.run(`INSERT INTO host_meta(key, value) VALUES ('assurance', ?)`, storeAssurance);
      else if (marked.value !== storeAssurance) throw new HostError(409, 'assurance_mismatch', `This store was created for ${marked.value} assurance and cannot be opened as ${assurance}.`);
      if (recover) this.recover();
      else this.refreshBlock();
    } catch (error) {
      try { this.close(); } catch (cleanupError) { preserveCleanupFailure(error, cleanupError); }
      throw error;
    }
  }

  requireWritable() {
    if (this.readOnly) throw new HostError(409, 'read_only_host', 'This view of the host store is read-only; only the live owner may change authority.');
  }

  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS host_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = this.db.prepare('SELECT MAX(version) AS v FROM host_migrations').get().v || 0;
    const steps = HOST_MIGRATIONS.map(path => readFileSync(path, 'utf8'));
    if (applied > steps.length) throw new Error(`Host store version ${applied} is newer than this host supports.`);
    for (let index = applied; index < steps.length; index++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(steps[index]);
        this.db.prepare('INSERT INTO host_migrations(version, sha256, applied_at) VALUES (?, ?, ?)').run(index + 1, sha256(Buffer.from(steps[index])), new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  // Single authority owner per state directory. A live owner's lock file names its process; a dead owner's is taken over
  // only through this path, which records the takeover and reconciles the store afterwards.
  acquireOwnership() {
    this.requireWritable();
    const path = join(this.root, 'host-owner.json');
    const claim = JSON.stringify({ hostInstance: this.hostInstance, pid: process.pid, acquiredAt: nowIsoFrom(this.time) });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx');
        writeSync(fd, claim);
        closeSync(fd);
        this.ownerPath = path;
        return { hostInstance: this.hostInstance };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const current = JSON.parse(readFileSync(path, 'utf8') || 'null');
      if (current && current.hostInstance !== this.hostInstance && processAlive(current.pid)) {
        throw new HostError(409, 'owner_running', `Another Local Control Host (pid ${current.pid}) owns this state.`);
      }
      unlinkSync(path);
      this.audit('host.owner_takeover', { previousPid: current?.pid ?? null, previousHostInstance: current?.hostInstance ?? null });
    }
    throw new HostError(409, 'owner_running', 'The authority owner changed while this host was starting.');
  }

  releaseOwnership() {
    if (this.ownerPath && existsSync(this.ownerPath)) {
      const current = JSON.parse(readFileSync(this.ownerPath, 'utf8') || 'null');
      if (current?.hostInstance === this.hostInstance) unlinkSync(this.ownerPath);
    }
    this.ownerPath = null;
  }

  close() {
    const failures = [];
    try { this.releaseOwnership(); } catch (error) { failures.push(error); }
    if (this.db) {
      try { this.db.close(); this.db = null; } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      for (const error of failures.slice(1)) preserveCleanupFailure(failures[0], error);
      throw failures[0];
    }
  }

  // One serialized transaction: BEGIN IMMEDIATE takes the write lock, so concurrent hosts and requests linearize.
  transaction(fn) {
    this.requireWritable();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* already ended */ } throw error; }
  }

  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  audit(eventType, payload, { sessionId = null, policyId = null } = {}) {
    const last = this.get('SELECT sequence, event_sha256 FROM audit_events ORDER BY sequence DESC LIMIT 1');
    const sequence = (last?.sequence || 0) + 1;
    const previous = last?.event_sha256 || GENESIS;
    const recordedAt = nowIsoFrom(this.time);
    const bootId = this.time.bootId() || 'unknown';
    const body = { sequence, sessionId, policyId, eventType, payload, previous, recordedAt, hostInstance: this.hostInstance, bootId };
    this.run(`INSERT INTO audit_events(sequence, session_id, policy_id, event_type, payload_json, previous_sha256, event_sha256, recorded_at, host_instance, boot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sequence, sessionId, policyId, eventType, canonicalize(payload), previous, canonicalHash(body), recordedAt, this.hostInstance, bootId);
  }

  // Detects damage and reordering of the host audit. Not an adversarial guarantee in a same-user writable store.
  verifyAudit() {
    let previous = GENESIS;
    for (const row of this.all('SELECT * FROM audit_events ORDER BY sequence')) {
      const body = { sequence: row.sequence, sessionId: row.session_id, policyId: row.policy_id, eventType: row.event_type, payload: JSON.parse(row.payload_json),
        previous: row.previous_sha256, recordedAt: row.recorded_at, hostInstance: row.host_instance, bootId: row.boot_id };
      if (row.previous_sha256 !== previous || canonicalHash(body) !== row.event_sha256) return { intact: false, brokenAt: row.sequence };
      previous = row.event_sha256;
    }
    return { intact: true, brokenAt: null };
  }

  // ---------- Trusted credentials (installation only; never exposed over IPC) ----------
  enrollCredential({ credentialId, publicKey, label }, { enrolledBy }) {
    if (!enrolledBy) throw new HostError(403, 'installation_required', 'Credential enrollment belongs to the protected installation procedure.');
    publicKeyFrom(publicKey);
    this.transaction(() => {
      if (this.get('SELECT credential_id FROM trusted_credentials WHERE credential_id = ?', credentialId)) throw new HostError(409, 'conflict', 'The credential is already enrolled.');
      this.run('INSERT INTO trusted_credentials(credential_id, public_key, label, enrolled_at, enrolled_by) VALUES (?, ?, ?, ?, ?)', credentialId, publicKey, label, nowIsoFrom(this.time), enrolledBy);
      this.audit('credential.enrolled', { credentialId, label, enrolledBy });
    });
    return { credentialId };
  }

  // ---------- Consent: an immutable proposed decision and a fresh single-use challenge ----------
  proposePolicy({ decisionType = 'create', supersedesPolicyId = null, controller, scope, limits, durationMs,initialPlan }) {
    this.requireWritable();
    let sessionId = randomUUID();
    let carriedUsage = zeroCost();
    if (decisionType === 'create') {
      if (supersedesPolicyId) throw new HostError(400, 'invalid_request', 'A new policy does not supersede another; use extend, widen or post_reboot.');
    } else {
      const previous = this.policyRow(supersedesPolicyId);
      if (previous.state === 'revoked') throw new HostError(409, 'revoked', 'A revoked policy cannot be extended; request a new policy.');
      if (decisionType === 'post_reboot' && previous.boot_id === this.time.bootId()) throw new HostError(409, 'conflict', 'The previous policy belongs to this boot; request an extension instead.');
      sessionId = previous.session_id;
      carriedUsage = this.usage(sessionId);
    }
    const issuedAtMs = this.time.wallNow();
    const decision = {
      schemaVersion: 1, kind: 'AutonomyPolicyDecision', policyId: randomUUID(), sessionId, decisionType, supersedesPolicyId,
      audience: this.audience, controller, scope, limits, carriedUsage, durationMs,
      issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(issuedAtMs + durationMs).toISOString(),
    };
    if(scope?.verificationOnly&&(scope.operations.some(operation=>!VERIFICATION_OPERATIONS.has(operation))||scope.commands.length||['attempts','providerInvocations','workerModelCalls','repairs','builds'].some(key=>limits[key]!==0)))throw new HostError(400,'invalid_verification_scope','Native verification cannot authorize workflow/provider/command execution or model/repair/build budgets.');
    if(initialPlan!==undefined){decision.initialPlan=initialPlan;validateControllerPlan(initialPlan,decision);}
    contract('proposedDecision', decision, 'The proposed policy decision');
    const challenge = { challengeId: randomUUID(), nonce: randomBytes(32).toString('hex'), decisionDigest: canonicalHash(decision), audience: this.audience,
      expiresAt: new Date(issuedAtMs + CHALLENGE_LIFETIME_MS).toISOString() };
    this.transaction(() => {
      this.run(`INSERT INTO consent_challenges(challenge_id, nonce, decision_json, decision_digest, audience, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        challenge.challengeId, challenge.nonce, canonicalize(decision), challenge.decisionDigest, this.audience, decision.issuedAt, challenge.expiresAt);
      this.audit('consent.challenge_issued', { challengeId: challenge.challengeId, decisionDigest: challenge.decisionDigest, decisionType }, { sessionId, policyId: decision.policyId });
    });
    return { ...challenge, decision };
  }

  // Verifies a decision-bound assertion from an enrolled credential and atomically consumes the challenge.
  authorizePolicy({ challengeId, assertion }) {
    this.requireWritable();
    if (this.assurance !== 'fixture') throw new HostError(403, 'trusted_consent_required', 'Installed authority requires the protected WebAuthn broker; software fixture assertions cannot authorize it.');
    contract('consentAssertion', assertion, 'The consent assertion');
    const challenge = this.get('SELECT * FROM consent_challenges WHERE challenge_id = ?', challengeId);
    if (!challenge) throw new HostError(404, 'not_found', 'Consent challenge not found.');
    const refuse = (code, message) => { this.audit('consent.refused', { challengeId, code }); throw new HostError(403, code, message); };
    const decision = JSON.parse(challenge.decision_json);
    if (canonicalHash(decision) !== challenge.decision_digest) refuse('decision_altered', 'The stored decision no longer matches its digest.');
    const data = assertion.clientData;
    if (data.challengeId !== challengeId || data.nonce !== challenge.nonce) refuse('challenge_mismatch', 'The assertion answers another challenge.');
    if (data.decisionDigest !== challenge.decision_digest) refuse('decision_substituted', 'The assertion was made for a different decision.');
    if (data.audience !== challenge.audience || data.audience !== this.audience) refuse('wrong_audience', 'The assertion was made for another host.');
    if (!assertion.flags.userPresent || !assertion.flags.userVerified) refuse('user_not_verified', 'The authenticator did not report user verification.');
    const credential = this.get('SELECT * FROM trusted_credentials WHERE credential_id = ? AND retired_at IS NULL', assertion.credentialId);
    if (!credential) refuse('untrusted_credential', 'The credential is not enrolled by the protected installation.');
    if (!signatureValid(credential.public_key, { clientData: data, flags: assertion.flags }, assertion.signature)) refuse('bad_signature', 'The assertion signature does not verify.');
    // A lost reply is reconciled to the receipt already committed, never turned into a second authorization.
    if (challenge.consumed_at) {
      if (!challenge.policy_id) refuse('challenge_consumed', 'The challenge was already used.');
      return { ...this.policyReceipt(this.policyRow(challenge.policy_id)), replayed: true };
    }
    if (Date.parse(challenge.expires_at) <= this.time.wallNow()) refuse('challenge_expired', 'The consent challenge expired; request a new one.');
    const bootId = this.time.bootId();
    if (!bootId) refuse('boot_identity_unavailable', 'The host cannot identify this boot, so it cannot anchor a policy.');
    const row = this.transaction(() => {
      const claimed = this.run('UPDATE consent_challenges SET consumed_at = ?, policy_id = ? WHERE challenge_id = ? AND consumed_at IS NULL', nowIsoFrom(this.time), decision.policyId, challengeId);
      if (claimed.changes !== 1) throw new HostError(409, 'challenge_consumed', 'The challenge was consumed concurrently.');
      let revision = 1;
      if (decision.supersedesPolicyId) {
        const previous = this.policyRow(decision.supersedesPolicyId);
        if (previous.state === 'revoked') throw new HostError(409, 'revoked', 'The policy was revoked before consent completed.');
        revision = previous.revision + 1;
        this.run(`UPDATE policies SET state = 'superseded' WHERE policy_id = ? AND state = 'active'`, previous.policy_id);
        this.releaseIssuedPermits(previous.policy_id, nowIsoFrom(this.time));
      }
      // The anchor is taken when the decision commits; the displayed expiry is also an upper bound.
      const anchor = this.time.uptimeMs() - Math.max(0, this.time.wallNow() - Date.parse(decision.issuedAt));
      this.run(`INSERT INTO policies(policy_id, session_id, supersedes_policy_id, revision, decision_json, decision_digest, consent_json, challenge_id, issued_at, expires_at, duration_ms, boot_id, uptime_anchor_ms, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`, decision.policyId, decision.sessionId, decision.supersedesPolicyId, revision, challenge.decision_json, challenge.decision_digest,
      canonicalize(assertion), challengeId, decision.issuedAt, decision.expiresAt, decision.durationMs, bootId, anchor);
      this.audit('policy.authorized', { challengeId, decisionDigest: challenge.decision_digest, revision, decisionType: decision.decisionType, credentialId: assertion.credentialId },
        { sessionId: decision.sessionId, policyId: decision.policyId });
      return this.policyRow(decision.policyId);
    });
    return { ...this.policyReceipt(row), replayed: false };
  }

  policyRow(policyId) {
    const row = this.get('SELECT * FROM policies WHERE policy_id = ?', policyId);
    if (!row) throw new HostError(404, 'not_found', 'Policy not found.');
    return row;
  }

  // Called inside the protected WebAuthn verifier's transaction, never exposed as a public protocol method.
  commitVerifiedConsent(challengeId, evidence) {
    this.requireWritable();
    const challenge = this.get('SELECT * FROM consent_challenges WHERE challenge_id = ?', challengeId);
    if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= this.time.wallNow()) throw new HostError(403, 'challenge_expired', 'The policy proposal is absent, consumed or expired.');
    const decision = JSON.parse(challenge.decision_json), bootId = this.time.bootId();
    if (!bootId || canonicalHash(decision) !== challenge.decision_digest || evidence.displayedDecisionDigest !== challenge.decision_digest) throw new HostError(403, 'decision_altered', 'The policy/boot binding is invalid.');
    let revision = 1;
    if (decision.supersedesPolicyId) {
      const previous = this.policyRow(decision.supersedesPolicyId);
      if (previous.state === 'revoked' || previous.state === 'superseded') throw new HostError(409, 'conflict', 'The previous authority changed before consent completed.');
      revision = previous.revision + 1;
      this.run("UPDATE policies SET state = 'superseded' WHERE policy_id = ?", previous.policy_id);
      this.releaseIssuedPermits(previous.policy_id, nowIsoFrom(this.time));
    }
    const claimed = this.run('UPDATE consent_challenges SET consumed_at = ?, policy_id = ? WHERE challenge_id = ? AND consumed_at IS NULL', nowIsoFrom(this.time), decision.policyId, challengeId);
    if (claimed.changes !== 1) throw new HostError(409, 'challenge_consumed', 'The policy challenge was consumed concurrently.');
    const anchor = this.time.uptimeMs() - Math.max(0, this.time.wallNow() - Date.parse(decision.issuedAt));
    this.run(`INSERT INTO policies(policy_id,session_id,supersedes_policy_id,revision,decision_json,decision_digest,consent_json,challenge_id,issued_at,expires_at,duration_ms,boot_id,uptime_anchor_ms,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active')`, decision.policyId, decision.sessionId, decision.supersedesPolicyId, revision, challenge.decision_json, challenge.decision_digest, canonicalize(evidence), challengeId, decision.issuedAt, decision.expiresAt, decision.durationMs, bootId, anchor);
    this.audit('policy.authorized', { challengeId, decisionDigest: challenge.decision_digest, revision, mechanism: evidence.mechanism, credentialId: evidence.credentialId }, { policyId: decision.policyId, sessionId: decision.sessionId });
    return { ...this.policyReceipt(this.policyRow(decision.policyId)), replayed: false };
  }

  policyReceipt(row) {
    return { policyId: row.policy_id, sessionId: row.session_id, revision: row.revision, decisionDigest: row.decision_digest, issuedAt: row.issued_at, expiresAt: row.expires_at, state: row.state };
  }

  // ---------- Controller authentication (fresh per connection; never survives a restart) ----------
  controllerChallenge(policyId, controllerId) {
    const policy = this.policyRow(policyId);
    const decision = JSON.parse(policy.decision_json);
    if (decision.controller.controllerId !== controllerId) throw new HostError(403, 'controller_mismatch', 'This controller is not registered for the policy.');
    const nonce = randomBytes(32).toString('hex');
    this.controllerChallenges.set(nonce, { policyId, controllerId, expiresAt: this.time.uptimeMs() + 60_000 });
    return { nonce, audience: this.audience, policyId, controllerId };
  }

  authenticateController({ nonce, signature }) {
    const pending = this.controllerChallenges.get(nonce);
    this.controllerChallenges.delete(nonce);
    if (!pending || pending.expiresAt < this.time.uptimeMs()) throw new HostError(403, 'controller_auth_failed', 'Unknown or expired controller challenge.');
    const decision = JSON.parse(this.policyRow(pending.policyId).decision_json);
    const signed = { type: 'deszo.controller.auth', nonce, audience: this.audience, policyId: pending.policyId, controllerId: pending.controllerId };
    if (!signatureValid(decision.controller.publicKey, signed, signature)) {
      this.audit('controller.auth_refused', { controllerId: pending.controllerId }, { policyId: pending.policyId });
      throw new HostError(403, 'controller_auth_failed', 'The controller signature does not verify.');
    }
    const connectionId = randomUUID();
    this.controllerConnections.set(connectionId, { policyId: pending.policyId, controllerId: pending.controllerId, hostInstance: this.hostInstance });
    this.audit('controller.authenticated', { controllerId: pending.controllerId }, { policyId: pending.policyId });
    return { connectionId };
  }

  // ---------- Runtime registration (scoped; cannot become consent or controller authority) ----------
  // A launched runtime registers with the one-time proof the host issued for its launch. The proof is consumed in the
  // same transaction that allocates the generation, so a replay is refused and changes nothing.
  registerRuntime({ policyId, operationId, processEvidence, registrationNonce, peerEvidence = null }) {
    this.requireWritable();
    const policy = this.policyRow(policyId);
    const refuse = (code, message) => {
      this.audit('runtime.registration_refused', { operationId, code }, { sessionId: policy.session_id, policyId });
      throw new HostError(403, code, message);
    };
    if (typeof registrationNonce !== 'string' || !/^[a-f0-9]{64}$/.test(registrationNonce)) refuse('registration_refused', 'The runtime is not the process this host launched: a registration needs its one-time launch proof.');
    const digest = sha256(Buffer.from(registrationNonce));
    const proof = this.get('SELECT * FROM registration_proofs WHERE proof_sha256 = ?', digest);
    if (!proof || proof.kind !== 'launch' || proof.policy_id !== policyId || proof.operation_id !== operationId || proof.host_instance !== this.hostInstance) {
      refuse('registration_refused', 'The runtime is not the process this host launched: the proof is not a launch proof of this host for this operation.');
    }
    if (proof.consumed_at) refuse('proof_consumed', 'The launch proof was already used; the live runtime generation is unchanged.');
    const time = remainingAuthority(policy, this.time);
    if (policy.state !== 'active' || !time.valid || this.closedBarriers.has(policyId)) refuse('policy_not_active', `The policy is not valid for registration (${policy.state}, ${time.reason}).`);
    const operation = this.operationRow(operationId);
    if (operation.outcome !== 'in_progress' || operation.phase !== 'launched') refuse('operation_phase', `The operation is ${operation.outcome} at ${operation.phase}, not awaiting registration.`);
    const expected = JSON.parse(proof.expected_json);
    if (!sameProcess(expected, processEvidence) || (peerEvidence && !sameProcess(expected, peerEvidence))) {
      refuse('registration_refused', 'The runtime is not the process this host observed for the operation.');
    }
    const runtimeGeneration = randomUUID();
    const attachSecret = randomBytes(32).toString('hex');
    this.transaction(() => {
      const claimed = this.run('UPDATE registration_proofs SET consumed_at = ?, runtime_generation = ? WHERE proof_sha256 = ? AND consumed_at IS NULL', nowIsoFrom(this.time), runtimeGeneration, digest);
      if (claimed.changes !== 1) throw new HostError(403, 'proof_consumed', 'The launch proof was consumed concurrently.');
      this.audit('runtime.registered', { operationId, runtimeGeneration, processEvidence: expected, peerVerified: Boolean(peerEvidence) }, { sessionId: policy.session_id, policyId });
    });
    for (const [generation, registration] of this.runtimeRegistrations) if (registration.policyId === policyId) this.runtimeRegistrations.delete(generation);
    const verificationOnly=operation.kind==='app.verify';
    this.runtimeRegistrations.set(runtimeGeneration, { policyId, operationId, verificationOnly, processEvidence: expected, hostInstance: this.hostInstance, attachSecretSha256: sha256(attachSecret) });
    return { runtimeGeneration, attachSecret, assurance: this.assurance,verificationOnly };
  }

  // The controlling runtime at session start. The authenticated controller attests its process; the host records it and
  // returns an attach secret that only that runtime receives. Attaching later requires the secret, never the generation alone.
  registerInitialRuntime({ policyId, processEvidence, connectionId }) {
    this.requireWritable();
    this.requireController(connectionId, policyId);
    const runtimeGeneration = randomUUID();
    const attachSecret = randomBytes(32).toString('hex');
    this.runtimeRegistrations.set(runtimeGeneration, { policyId, operationId: null, processEvidence, hostInstance: this.hostInstance, attachSecretSha256: sha256(attachSecret) });
    this.transaction(() => this.audit('runtime.registered', { operationId: null, runtimeGeneration, processEvidence, basis: 'controller_attested_initial' }, { policyId }));
    return { runtimeGeneration, attachSecret, assurance: this.assurance };
  }

  // Retires a registered generation whose launch failed verification, so no later permit can name it.
  retireRuntime(runtimeGeneration, reason) {
    const registration = this.runtimeRegistrations.get(runtimeGeneration);
    if (!registration) return false;
    this.runtimeRegistrations.delete(runtimeGeneration);
    this.transaction(() => this.audit('runtime.retired', { runtimeGeneration, reason }, { policyId: registration.policyId }));
    return true;
  }

  attachRuntime({ policyId, runtimeGeneration, attachSecret }) {
    const registration = this.runtimeRegistrations.get(runtimeGeneration);
    const valid = Boolean(registration) && registration.policyId === policyId && registration.hostInstance === this.hostInstance
      && typeof attachSecret === 'string' && digestsEqual(sha256(Buffer.from(attachSecret)), registration.attachSecretSha256);
    if (!valid) {
      this.audit('runtime.attach_refused', { runtimeGeneration: typeof runtimeGeneration === 'string' ? runtimeGeneration : null }, { policyId });
      throw new HostError(403, 'registration_refused', 'The runtime generation and attach secret do not match a live registration.');
    }
    const policy = this.policyRow(policyId);
    const time = remainingAuthority(policy, this.time);
    if (policy.state !== 'active' || !time.valid) throw new HostError(403, 'policy_not_active', `The policy is not valid for attachment (${policy.state}, ${time.reason}).`);
    return { attached: true, runtimeGeneration, assurance: this.assurance };
  }

  requireController(connectionId, policyId) {
    const connection = this.controllerConnections.get(connectionId);
    if (!connection || connection.policyId !== policyId || connection.hostInstance !== this.hostInstance) throw new HostError(403, 'controller_not_authenticated', 'This request needs an authenticated controller connection for the policy.');
    return connection;
  }

  // A registered runtime's connection is a party only for the generation it registered, under a live policy.
  requireRuntimeParty(runtime, policyId, runtimeGeneration) {
    const registration = runtime && this.runtimeRegistrations.get(runtime.runtimeGeneration);
    const ok = Boolean(registration) && runtime.policyId === policyId && registration.policyId === policyId && runtime.runtimeGeneration === runtimeGeneration && registration.hostInstance === this.hostInstance;
    if (!ok) throw new HostError(403, 'not_a_party', 'This connection is not the live runtime generation the request names.');
    return registration;
  }

  // Whether a process was started or registered by this host for the policy. Stop and restart target only such processes.
  // Whether this host launched the process for the policy (lifecycle launches only; registrations of a controller do not count).
  launchedByHost(policyId, process) {
    return this.all('SELECT evidence_json FROM operations WHERE policy_id = ?', policyId)
      .some(row => sameProcess(JSON.parse(row.evidence_json).launch, process));
  }

  ownsProcess(policyId, process) {
    for (const registration of this.runtimeRegistrations.values()) {
      if (registration.policyId === policyId && sameProcess(registration.processEvidence, process)) return true;
    }
    return this.all('SELECT evidence_json FROM operations WHERE policy_id = ?', policyId)
      .some(row => sameProcess(JSON.parse(row.evidence_json).launch, process));
  }

  // ---------- Ledger ----------
  usage(sessionId) {
    const used = zeroCost();
    for (const row of this.all(`SELECT budget_key, SUM(amount) AS total FROM budget_ledger WHERE session_id = ? AND state IN ('reserved','consumed','unresolved') GROUP BY budget_key`, sessionId)) used[row.budget_key] = row.total;
    return used;
  }

  // The requester is the authenticated controller, or the live runtime generation for the operations it may request.
  authorizeRequester(request, { connectionId, runtime }) {
    if (runtime && RUNTIME_REQUESTABLE.has(request.operation)) {
      this.requireRuntimeParty(runtime, request.policyId, request.runtimeGeneration);
      return;
    }
    this.requireController(connectionId, request.policyId);
  }

  // ---------- Decisions ----------
  decide(request, { connectionId = null, runtime = null } = {}) {
    this.requireWritable();
    contract('decisionRequest', request, 'The decision request');
    this.authorizeRequester(request, { connectionId, runtime });
    const requestDigest = canonicalHash(request);
    return this.transaction(() => {
      const prior = this.get('SELECT * FROM decisions WHERE policy_id = ? AND request_id = ?', request.policyId, request.requestId);
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new HostError(409, 'conflict', 'The request ID was used for a different request.');
        return { ...JSON.parse(prior.receipt_json), replayed: true };
      }
      const policy = this.policyRow(request.policyId);
      const decision = JSON.parse(policy.decision_json);
      const minimum = MINIMUM_COST[request.operation] || {};
      const cost = zeroCost();
      for (const key of BUDGET_KEYS) cost[key] = Math.max(request.cost?.[key] || 0, minimum[key] || 0);
      cost.operations = Math.max(cost.operations, 1);
      const verdict = this.evaluate(policy, decision, request, cost);
      const used = this.usage(policy.session_id);
      const remaining = Object.fromEntries(BUDGET_KEYS.map(key => [key, Math.max(0, decision.limits[key] - used[key] - (verdict.outcome === 'approved' ? cost[key] : 0))]));
      const decisionId = randomUUID();
      const permitId = verdict.outcome === 'approved' ? randomUUID() : null;
      const decidedAt = nowIsoFrom(this.time);
      const receipt = {
        schemaVersion: 1, kind: 'HostDecisionReceipt', decisionId, requestId: request.requestId, policyId: policy.policy_id, policyRevision: policy.revision,
        revocationGeneration: policy.revocation_generation, operation: request.operation, outcome: verdict.outcome, reason: verdict.reason, permitId,
        reservation: verdict.outcome === 'approved' ? cost : zeroCost(), remaining, requestDigest, decidedAt,
      };
      contract('decisionReceipt', receipt, 'The decision receipt');
      this.run('INSERT INTO decisions(decision_id, request_id, policy_id, request_digest, request_json, operation, outcome, receipt_json, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        decisionId, request.requestId, policy.policy_id, requestDigest, canonicalize(request), request.operation, verdict.outcome, canonicalize(receipt), decidedAt);
      if (permitId) {
        this.run(`INSERT INTO permits(permit_id, decision_id, policy_id, generation, host_instance, state, issued_at) VALUES (?, ?, ?, ?, ?, 'issued', ?)`,
          permitId, decisionId, policy.policy_id, policy.revocation_generation, this.hostInstance, decidedAt);
        for (const key of BUDGET_KEYS) if (cost[key] > 0) {
          this.run(`INSERT INTO budget_ledger(entry_id, session_id, policy_id, permit_id, budget_key, amount, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
            randomUUID(), policy.session_id, policy.policy_id, permitId, key, cost[key], decidedAt);
        }
      }
      this.audit('decision.recorded', { decisionId, requestId: request.requestId, operation: request.operation, outcome: verdict.outcome, reason: verdict.reason, permitId,
        justification: request.justification ?? null, requester: runtime ? 'runtime' : 'controller' }, { sessionId: policy.session_id, policyId: policy.policy_id });
      return receipt;
    });
  }

  // Returns { outcome, reason } for a request against a policy; the caller records it.
  evaluate(policy, decision, request, cost) {
    const scope=decision.scope;
    const registered=this.runtimeRegistrations.get(request.runtimeGeneration);
    const verificationAllowed=scope.verificationOnly===true&&(request.operation==='app.verify'||(['runtime.reregister','app.stop'].includes(request.operation)&&registered?.verificationOnly&&registered.policyId===policy.policy_id));
    if(scope.verificationOnly&&!VERIFICATION_OPERATIONS.has(request.operation))return{outcome:'denied',reason:'verification_only_policy'};
    if(request.operation==='app.verify'&&!scope.verificationOnly)return{outcome:'denied',reason:'verification_scope_required'};
    if (this.assurance === 'bootstrap' && !FAIL_CLOSED_EXEMPT.has(request.operation)&&!verificationAllowed) return { outcome: 'denied', reason: 'autonomy_disabled: native enablement evidence is incomplete' };
    if (policy.state === 'revoked') return { outcome: 'denied', reason: 'revoked' };
    if (policy.state === 'superseded') return { outcome: 'denied', reason: 'superseded' };
    const time = remainingAuthority(policy, this.time);
    if (!time.valid) return { outcome: 'denied', reason: time.reason };
    if (this.closedBarriers.has(policy.policy_id)) return { outcome: 'denied', reason: 'admission_barrier_closed' };
    if (this.dispatchBlocked && !FAIL_CLOSED_EXEMPT.has(request.operation)) return { outcome: 'pending', reason: `host_reconciling: ${this.dispatchBlocked}` };
    if (!FAIL_CLOSED_EXEMPT.has(request.operation) && this.applicationStopping(policy.policy_id)) return { outcome: 'pending', reason: 'application_stopping' };
    if (!scope.operations.includes(request.operation)) return { outcome: 'denied', reason: 'operation_not_authorized' };
    if (request.workspaceId !== undefined && !scope.workspaces.some(w => w.workspaceId === request.workspaceId)) return { outcome: 'denied', reason: 'workspace_not_authorized' };
    // Provider charges name the workspace directory they run in: a workspace re-pointed to another directory is refused.
    if (request.operation === PROVIDER_OPERATION && !request.workspaceCwdIdentity) return { outcome: 'denied', reason: 'workspace_binding_required' };
    if (request.workspaceCwdIdentity !== undefined) {
      const bound = scope.workspaces.find(w => w.workspaceId === request.workspaceId);
      if (bound && bound.cwdIdentity !== request.workspaceCwdIdentity) return { outcome: 'denied', reason: 'workspace_cwd_not_authorized' };
    }
    if (NEEDS_WORKFLOW.has(request.operation)) {
      if (!request.workspaceId || !request.workflowId || !request.workflowSnapshotSha256) return { outcome: 'denied', reason: 'workflow_binding_required' };
      const rule = scope.workflows.find(w => w.workflowId === request.workflowId);
      if (!rule) return { outcome: 'denied', reason: 'workflow_not_authorized' };
      if (request.workflowSnapshotSha256 !== rule.baselineSha256 && !rule.permittedRevisions.includes(request.workflowSnapshotSha256)) {
        return { outcome: 'pending', reason: 'workflow_revision_not_authorized: the revision is outside the explicit policy and waits for a user decision' };
      }
    }
    if (NEEDS_COMMAND.has(request.operation)) {
      if (!request.commandId || !scope.commands.some(c => c.commandId === request.commandId)) return { outcome: 'denied', reason: 'command_not_authorized' };
    }
    if (NEEDS_RUNTIME.has(request.operation)) {
      const registration = request.runtimeGeneration ? this.runtimeRegistrations.get(request.runtimeGeneration) : null;
      if (!registration || registration.policyId !== policy.policy_id || registration.hostInstance !== this.hostInstance) return { outcome: 'denied', reason: 'runtime_not_registered' };
      if(registration.verificationOnly&&request.operation!=='runtime.reregister')return{outcome:'denied',reason:'runtime_verification_only'};
    }
    // Lifecycle requests must name exactly the authorized profile, build root, application mode and desktop, and may
    // stop only a process this host started or registered. Checked before any external effect.
    if (TARGET_OPERATIONS.has(request.operation)) {
      const target = request.target;
      if (!target) return { outcome: 'denied', reason: 'target_required' };
      if (target.profile !== scope.dataProfile) return { outcome: 'denied', reason: 'profile_not_authorized' };
      if (target.applicationMode !== scope.applicationMode) return { outcome: 'denied', reason: 'application_mode_not_authorized' };
      if (!sameDesktop(target.desktop, scope.desktop)) return { outcome: 'denied', reason: 'desktop_not_authorized' };
      if (!target.buildDir || !insideRoot(scope.buildRoot, target.buildDir)) return { outcome: 'denied', reason: 'build_root_not_authorized' };
      if (target.currentProcess && !this.ownsProcess(policy.policy_id, target.currentProcess)) return { outcome: 'denied', reason: 'stop_target_not_owned' };
      // A separate preview stops only what this host launched for it. The stable controlling runtime that a policy registered
      // at session start is outside the preview's scope and must survive a preview restart.
      if (target.currentProcess && scope.applicationMode === 'separate_preview' && !this.launchedByHost(policy.policy_id, target.currentProcess)) {
        return { outcome: 'denied', reason: 'controller_protected_in_preview' };
      }
    }
    const used = this.usage(policy.session_id);
    const exhausted = BUDGET_KEYS.find(key => used[key] + cost[key] > decision.limits[key]);
    if (exhausted) return { outcome: 'denied', reason: `budget_exhausted: ${exhausted}` };
    return { outcome: 'approved', reason: 'within_policy' };
  }

  permitView(permitId) {
    const permit = this.get('SELECT p.*, d.receipt_json, d.request_json, d.operation FROM permits p JOIN decisions d ON d.decision_id = p.decision_id WHERE p.permit_id = ?', permitId);
    if (!permit) throw new HostError(404, 'not_found', 'Permit not found.');
    return permit;
  }

  // The request a permit was decided for. The engine compares it with what it is about to admit.
  permitRequest(permitId) {
    const permit = this.permitView(permitId);
    return { permitId, state: permit.state, effect: permit.effect, policyId: permit.policy_id, decisionId: permit.decision_id, operation: permit.operation, request: JSON.parse(permit.request_json) };
  }

  // Read-only current authority check for a captured effect; never re-admit or refund a model invocation.
  validatePermit(permitId) {
    const permit=this.permitView(permitId),policy=this.policyRow(permit.policy_id),time=remainingAuthority(policy,this.time);
    return {permitId,valid:time.valid&&policy.state==='active'&&permit.generation===policy.revocation_generation&&permit.host_instance===this.hostInstance&&!this.closedBarriers.has(policy.policy_id)&&!this.dispatchBlocked&&!this.applicationStopping(policy.policy_id)&&(['admitted'].includes(permit.state)||(permit.state==='settled'&&permit.effect==='consumed')),remainingMs:time.remainingMs};
  }

  // ---------- Admission barrier ----------
  applicationStopping(policyId) {
    return Boolean(this.get("SELECT operation_id FROM operations WHERE policy_id=? AND kind='app.stop' AND outcome IN ('in_progress','reconciling')", policyId));
  }

  // A permit passes only while its revocation generation is current, its host instance is this one, the policy is
  // valid and no barrier is closed. The state change is the ordering point against revocation and expiry.
  admit(permitId) {
    return this.transaction(() => {
      const permit = this.permitView(permitId);
      const policy = this.policyRow(permit.policy_id);
      const refuse = reason => {
        this.audit('admission.refused', { permitId, reason }, { sessionId: policy.session_id, policyId: policy.policy_id });
        return { admitted: false, reason };
      };
      if (permit.state !== 'issued') return refuse(`permit_${permit.state}`);
      if (permit.host_instance !== this.hostInstance) return refuse('stale_permit');
      if (this.closedBarriers.has(policy.policy_id)) return refuse('admission_barrier_closed');
      if (policy.state !== 'active') return refuse(`policy_${policy.state}`);
      if (permit.generation !== policy.revocation_generation) return refuse('stale_generation');
      const time = remainingAuthority(policy, this.time);
      if (!time.valid) return refuse(time.reason);
      if (this.dispatchBlocked && !FAIL_CLOSED_EXEMPT.has(permit.operation)) return refuse('host_reconciling');
      if (!FAIL_CLOSED_EXEMPT.has(permit.operation) && this.applicationStopping(policy.policy_id)) return refuse('application_stopping');
      const claimed = this.run(`UPDATE permits SET state = 'admitted', admitted_at = ? WHERE permit_id = ? AND state = 'issued'`, nowIsoFrom(this.time), permitId);
      if (claimed.changes !== 1) return refuse('permit_raced');
      this.audit('admission.granted', { permitId, decisionId: permit.decision_id, remainingMs: time.remainingMs }, { sessionId: policy.session_id, policyId: policy.policy_id });
      // Native supervision receives a deadline capped by the remaining authorized lifetime.
      return { admitted: true, permitId, policyId: policy.policy_id, enforcementDeadlineMs: time.remainingMs };
    });
  }

  // Records what actually happened to an admitted (or never-admitted) permit's effect. A consumed effect that created
  // work records that work as owned by the permit: it stays in the Stop scope until it is observed terminal, whatever
  // the accounting state of the permit.
  settle(permitId, { effect, evidence, workRef = null }) {
    if (!['consumed', 'not_executed', 'unknown'].includes(effect)) throw new HostError(400, 'invalid_request', 'effect must be consumed, not_executed or unknown.');
    if (effect === 'not_executed' && !evidence) throw new HostError(400, 'invalid_request', 'Returning a reservation needs evidence that the effect did not occur.');
    if (workRef && effect !== 'consumed') throw new HostError(400, 'invalid_request', 'Owned work exists only for a consumed effect.');
    return this.transaction(() => {
      const permit = this.permitView(permitId);
      if (permit.state === 'settled') {
        if (permit.effect !== effect) throw new HostError(409, 'conflict', `The permit was already settled as ${permit.effect}.`);
        if (workRef) this.recordWork(permit, workRef);
        return { permitId, effect, replayed: true };
      }
      if (permit.state === 'invalidated') throw new HostError(409, 'conflict', 'The permit was invalidated; its reservation was already returned.');
      // A refused admission leaves the permit issued; its reservation is returned only as not_executed.
      if (permit.state === 'issued' && effect !== 'not_executed') throw new HostError(409, 'not_admitted', 'Only a refused permit can be settled without admission, and only as not_executed.');
      if (!['admitted', 'issued'].includes(permit.state)) throw new HostError(409, 'conflict', `The permit is ${permit.state}.`);
      const ledgerState = effect === 'consumed' ? 'consumed' : effect === 'not_executed' ? 'released' : 'unresolved';
      this.run(`UPDATE budget_ledger SET state = ?, settled_at = ? WHERE permit_id = ? AND state = 'reserved'`, ledgerState, nowIsoFrom(this.time), permitId);
      this.run(`UPDATE permits SET state = 'settled', effect = ?, settled_at = ? WHERE permit_id = ?`, effect, nowIsoFrom(this.time), permitId);
      const policy = this.policyRow(permit.policy_id);
      if (workRef) this.recordWork(permit, workRef);
      this.audit('permit.settled', { permitId, effect, evidence: evidence ?? null, workRef }, { sessionId: policy.session_id, policyId: policy.policy_id });
      return { permitId, effect, replayed: false };
    });
  }

  recordWork(permit, workRef) {
    const policy = this.policyRow(permit.policy_id);
    const workId = randomUUID();
    this.run(`INSERT OR IGNORE INTO active_work(work_id, policy_id, session_id, permit_id, work_ref, kind, host_instance, state, created_at) VALUES (?, ?, ?, ?, ?, 'run', ?, 'active', ?)`,
      workId, policy.policy_id, policy.session_id, permit.permit_id, workRef, this.hostInstance, nowIsoFrom(this.time));
    this.audit('work.owned', { permitId: permit.permit_id, workRef }, { sessionId: policy.session_id, policyId: policy.policy_id });
  }

  // The runtime reports owned work terminal. Work of a previous host instance is not released here: it needs native reconciliation.
  releaseWork(permitId, workRef, { evidence }) {
    if (!evidence?.terminalState) throw new HostError(400, 'invalid_request', 'Releasing owned work needs its observed terminal state.');
    const result = this.transaction(() => {
      const row = this.get('SELECT * FROM active_work WHERE permit_id = ? AND work_ref = ?', permitId, workRef);
      if (!row) throw new HostError(404, 'not_found', 'The work is not owned by this permit.');
      if (row.state === 'released') return { released: true, replayed: true };
      if (row.host_instance !== this.hostInstance) throw new HostError(409, 'orphaned_work', 'The work belongs to a previous host instance; it needs native reconciliation.');
      this.run(`UPDATE active_work SET state = 'released', released_at = ?, release_evidence_json = ? WHERE work_id = ?`, nowIsoFrom(this.time), canonicalize(evidence), row.work_id);
      this.audit('work.released', { workRef, terminalState: evidence.terminalState }, { policyId: row.policy_id, sessionId: row.session_id });
      return { released: true, replayed: false };
    });
    this.refreshBlock();
    return result;
  }

  // Native reconciliation of owned work from a previous host instance, after the native supervisor has observed its end.
  reconcileOrphanedWork(workRef, { evidence }) {
    if (!evidence?.nativeObservation) throw new HostError(400, 'invalid_request', 'Orphaned work needs a native observation of its end.');
    this.transaction(() => {
      const row = this.get(`SELECT * FROM active_work WHERE work_ref = ? AND state = 'active' AND host_instance != ?`, workRef, this.hostInstance);
      if (!row) throw new HostError(404, 'not_found', 'No orphaned active work matches this reference.');
      this.run(`UPDATE active_work SET state = 'released', released_at = ?, release_evidence_json = ? WHERE work_id = ?`, nowIsoFrom(this.time), canonicalize(evidence), row.work_id);
      this.audit('work.reconciled', { workRef, nativeObservation: evidence.nativeObservation }, { policyId: row.policy_id, sessionId: row.session_id });
    });
    this.refreshBlock();
    return { workRef, released: true };
  }

  // A superseded policy keeps its owned work under the session, but none of its unadmitted permits may be admitted now.
  // They are invalidated so their reservations stop counting against the session's shared budget.
  releaseIssuedPermits(policyId, at) {
    for (const permit of this.all(`SELECT permit_id FROM permits WHERE policy_id = ? AND state = 'issued'`, policyId)) {
      this.run(`UPDATE permits SET state = 'invalidated', settled_at = ? WHERE permit_id = ? AND state = 'issued'`, at, permit.permit_id);
      this.run(`UPDATE budget_ledger SET state = 'released', settled_at = ? WHERE permit_id = ? AND state = 'reserved'`, at, permit.permit_id);
    }
  }

  // ---------- Revocation and expiry ----------
  // Invalidates unadmitted permits of the policies, returns their reservations and returns the native Stop scope: admitted
  // permits and every active work item still owned by them, whatever their accounting state.
  closePolicies(policyIds, at) {
    const permits = new Set();
    const works = [];
    for (const policyId of policyIds) {
      this.closedBarriers.add(policyId);
      for (const permit of this.all(`SELECT permit_id FROM permits WHERE policy_id = ? AND state = 'issued'`, policyId)) {
        this.run(`UPDATE permits SET state = 'invalidated', settled_at = ? WHERE permit_id = ? AND state = 'issued'`, at, permit.permit_id);
        this.run(`UPDATE budget_ledger SET state = 'released', settled_at = ? WHERE permit_id = ? AND state = 'reserved'`, at, permit.permit_id);
      }
      for (const permit of this.all(`SELECT permit_id FROM permits WHERE policy_id = ? AND state = 'admitted'`, policyId)) permits.add(permit.permit_id);
      for (const work of this.all(`SELECT work_id, permit_id, work_ref FROM active_work WHERE policy_id = ? AND state = 'active'`, policyId)) {
        permits.add(work.permit_id);
        works.push({ workId: work.work_id, permitId: work.permit_id, workRef: work.work_ref });
      }
    }
    return { permits: [...permits], works };
  }

  // Closes the in-memory barrier first, then commits the generation change, then reports the Stop scope. A failed commit
  // leaves dispatch blocked; it is never reported as a committed revocation.
  revoke(policyId, { actor, connectionId = null }) {
    this.requireWritable();
    if (!actor) throw new HostError(400, 'invalid_request', 'Revocation records who requested it.');
    if (connectionId) this.requireController(connectionId, policyId);
    this.closedBarriers.add(policyId);
    let result, closedPolicyIds;
    try {
      result = this.transaction(() => {
        const policy = this.policyRow(policyId);
        const at = nowIsoFrom(this.time);
        // Superseded policies keep their owned work under the session, so revocation covers the whole chain, not only active rows.
        const ids = [...new Set([policyId, ...this.all("SELECT policy_id FROM policies WHERE session_id = ? AND state IN ('active','superseded')", policy.session_id).map(r => r.policy_id)])];
        closedPolicyIds = ids;
        for (const id of ids) {
          this.run(`UPDATE policies SET state = 'revoked', revocation_generation = revocation_generation + 1, revoked_at = ?, revoked_by = ? WHERE policy_id = ? AND state != 'revoked'`, at, actor, id);
        }
        const scope = this.closePolicies(ids, at);
        this.audit('policy.revoked', { actor, stopScope: scope.permits, stopWorks: scope.works.map(w => w.workRef) }, { sessionId: policy.session_id, policyId });
        return { policyId, committed: true, stopScope: scope.permits, stopWorks: scope.works };
      });
    } catch (error) {
      this.revocationFailure = `revocation of ${policyId} did not commit: ${error.message}`;
      this.refreshBlock();
      throw error;
    }
    for (const [id, connection] of this.controllerConnections) if (connection.policyId === policyId) this.controllerConnections.delete(id);
    if (this.onStop) this.onStop(result.stopScope, result.stopWorks, { policyIds: closedPolicyIds });
    this.refreshBlock();
    return result;
  }

  // Enforcement of the authorized lifetime, run by the host's own timer (not by the candidate or the event loop of a
  // runtime). A policy whose remaining authority has ended is closed exactly once: no new permit is issued or admitted,
  // and its owned work and admitted permits are reported for native Stop.
  enforceExpiry() {
    this.requireWritable();
    const at = nowIsoFrom(this.time);
    const closed = [];
    const result = this.transaction(() => {
      const permits = new Set();
      const works = [];
      for (const policy of this.all(`SELECT * FROM policies WHERE state = 'active'`)) {
        if (this.closedBarriers.has(policy.policy_id)) continue;
        const time = remainingAuthority(policy, this.time);
        if (time.valid) continue;
        // Expiry of the policy that covers the session also closes the policies it superseded: their owned work is in its scope.
        const chain = this.all("SELECT policy_id FROM policies WHERE session_id = ? AND state IN ('active','superseded')", policy.session_id).map(r => r.policy_id);
        const scope = this.closePolicies(chain, at);
        scope.permits.forEach(id => permits.add(id));
        works.push(...scope.works);
        closed.push({ policyId: policy.policy_id, reason: time.reason });
        this.audit('policy.closed', { reason: time.reason, stopScope: scope.permits, stopWorks: scope.works.map(w => w.workRef) }, { sessionId: policy.session_id, policyId: policy.policy_id });
      }
      return { permits: [...permits], works };
    });
    if (this.onStop && (closed.length || result.permits.length || result.works.length)) this.onStop(result.permits, result.works, { policyIds: closed.map(p => p.policyId) });
    this.refreshBlock();
    return { closed, stopScope: result.permits, stopWorks: result.works };
  }

  // ---------- User surface (status and revocation while Deszo is closed) ----------
  // Revocation through the host's user surface is authorized by a secret the installation writes into the protected
  // state directory. It can only reduce authority, so it is accepted without further user verification.
  issueUserSurfaceToken() {
    this.requireWritable();
    const token = randomBytes(32).toString('hex');
    writeFileSync(join(this.root, 'user-surface.token'), token, { mode: 0o600 });
    this.userSurfaceSha256 = sha256(Buffer.from(token));
    return token;
  }

  authorizeUserSurface(token) {
    return this.userSurfaceSha256 !== null && typeof token === 'string' && digestsEqual(sha256(Buffer.from(token)), this.userSurfaceSha256);
  }

  // ---------- Durable operations ----------
  beginOperation({ permitId, kind, intent }) {
    return this.transaction(() => {
      const permit = this.permitView(permitId);
      if (permit.state !== 'admitted') throw new HostError(409, 'not_admitted', 'An operation starts only under an admitted permit.');
      if (permit.operation !== kind) throw new HostError(409, 'conflict', `The permit was decided for ${permit.operation}, not ${kind}.`);
      if (kind.startsWith('app.') && this.get("SELECT operation_id FROM operations WHERE policy_id=? AND kind LIKE 'app.%' AND outcome IN ('in_progress','reconciling')", permit.policy_id)) throw new HostError(409, 'lifecycle_busy', 'A lifecycle operation already owns this policy; reconcile its receipt before another replacement.');
      const operationId = randomUUID();
      const at = nowIsoFrom(this.time);
      this.run(`INSERT INTO operations(operation_id, policy_id, kind, phase, outcome, intent_json, evidence_json, permit_id, created_at, updated_at) VALUES (?, ?, ?, 'intent_recorded', 'in_progress', ?, '{}', ?, ?, ?)`,
        operationId, permit.policy_id, kind, canonicalize(intent), permitId, at, at);
      this.audit('operation.intent', { operationId, kind, permitId, decisionId: permit.decision_id, intentDigest: canonicalHash(intent) }, { policyId: permit.policy_id });
      return { operationId };
    });
  }

  recordPhase(operationId, phase, evidence = {}) {
    return this.transaction(() => {
      const operation = this.operationRow(operationId);
      if (operation.outcome !== 'in_progress') throw new HostError(409, 'conflict', `The operation is ${operation.outcome}.`);
      const merged = { ...JSON.parse(operation.evidence_json), ...evidence };
      this.run('UPDATE operations SET phase = ?, evidence_json = ?, updated_at = ? WHERE operation_id = ?', phase, canonicalize(merged), nowIsoFrom(this.time), operationId);
      this.audit('operation.phase', { operationId, phase, evidenceKeys: Object.keys(evidence) }, { policyId: operation.policy_id });
      return { operationId, phase };
    });
  }

  // Issues the one-time launch proof. The host generates the nonce and keeps only its digest; the nonce is returned once
  // to the launch path and is never stored in an operation, receipt or audit row.
  issueLaunchProof(operationId) {
    return this.transaction(() => {
      const operation = this.operationRow(operationId);
      if (operation.outcome !== 'in_progress') throw new HostError(409, 'conflict', `The operation is ${operation.outcome}.`);
      if (!['build_verified', 'old_terminated'].includes(operation.phase)) throw new HostError(409, 'conflict', `A launch needs a verified build; the operation is at ${operation.phase}.`);
      const policy = this.policyRow(operation.policy_id);
      const time = remainingAuthority(policy, this.time);
      if (policy.state !== 'active' || !time.valid || this.closedBarriers.has(policy.policy_id) || this.dispatchBlocked) throw new HostError(403, 'policy_not_active', `The policy is not valid/reconciled for a launch (${policy.state}, ${time.reason}).`);
      const nonce = randomBytes(32).toString('hex');
      this.run(`INSERT INTO registration_proofs(proof_sha256, policy_id, operation_id, kind, expected_json, host_instance, issued_at) VALUES (?, ?, ?, 'launch', '{}', ?, ?)`,
        sha256(Buffer.from(nonce)), policy.policy_id, operationId, this.hostInstance, nowIsoFrom(this.time));
      this.run(`UPDATE operations SET phase = 'launch_requested', updated_at = ? WHERE operation_id = ?`, nowIsoFrom(this.time), operationId);
      this.audit('launch.proof_issued', { operationId }, { policyId: policy.policy_id });
      return { registrationNonce: nonce };
    });
  }

  // Binds the process the host itself observed after the launch to the proof; registration must match it.
  bindLaunch(operationId, observed) {
    return this.transaction(() => {
      const operation = this.operationRow(operationId);
      if (operation.outcome !== 'in_progress' || operation.phase !== 'launch_requested') throw new HostError(409, 'conflict', `The operation is ${operation.outcome} at ${operation.phase}.`);
      const proof = this.get(`SELECT * FROM registration_proofs WHERE operation_id = ? AND consumed_at IS NULL AND expected_json = '{}'`, operationId);
      if (!proof) throw new HostError(409, 'conflict', 'The operation has no unbound launch proof.');
      this.run('UPDATE registration_proofs SET expected_json = ? WHERE proof_sha256 = ?', canonicalize(observed), proof.proof_sha256);
      this.run(`UPDATE operations SET phase = 'launched', evidence_json = ?, updated_at = ? WHERE operation_id = ?`,
        canonicalize({ ...JSON.parse(operation.evidence_json), launch: observed }), nowIsoFrom(this.time), operationId);
      this.audit('operation.phase', { operationId, phase: 'launched', evidenceKeys: ['launch'] }, { policyId: operation.policy_id });
      return { operationId, phase: 'launched' };
    });
  }

  finishOperation(operationId, { outcome, reason = null, evidence = {} }) {
    if (!['reconciling', 'blocked', 'failed', 'verified', 'interrupted'].includes(outcome)) throw new HostError(400, 'invalid_request', 'Unknown operation outcome.');
    if (outcome === 'blocked' && !reason) throw new HostError(400, 'invalid_request', 'A blocked operation records its reason and required next action.');
    const result = this.transaction(() => {
      const operation = this.operationRow(operationId);
      const merged = { ...JSON.parse(operation.evidence_json), ...evidence };
      if (outcome === 'verified' && !merged.verification?.complete) throw new HostError(409, 'evidence_incomplete', 'An operation is verified only when all of its required evidence is complete.');
      this.run('UPDATE operations SET outcome = ?, reason = ?, evidence_json = ?, updated_at = ? WHERE operation_id = ?', outcome, reason, canonicalize(merged), nowIsoFrom(this.time), operationId);
      this.audit('operation.finished', { operationId, outcome, reason }, { policyId: operation.policy_id });
      return { operationId, outcome };
    });
    this.refreshBlock();
    return result;
  }

  operationRow(operationId) {
    const row = this.get('SELECT * FROM operations WHERE operation_id = ?', operationId);
    if (!row) throw new HostError(404, 'not_found', 'Operation not found.');
    return row;
  }

  // ---------- Startup reconciliation ----------
  // SCM recovery restores availability, not authority. Permits of a previous host instance that were never admitted had
  // no effect and are invalidated; admitted ones have an unknown effect and keep their charge; operations in progress
  // become reconciling. Owned work of a previous instance stays in the Stop scope and blocks dispatch until it is reconciled.
  recover() {
    this.requireWritable();
    const audit = this.verifyAudit();
    if (!audit.intact) this.auditBroken = `host audit chain broken at event ${audit.brokenAt}`;
    const at = nowIsoFrom(this.time);
    this.transaction(() => {
      const stale = this.all(`SELECT permit_id FROM permits WHERE state = 'issued' AND host_instance != ?`, this.hostInstance);
      for (const permit of stale) {
        this.run(`UPDATE permits SET state = 'invalidated', settled_at = ? WHERE permit_id = ?`, at, permit.permit_id);
        this.run(`UPDATE budget_ledger SET state = 'released', settled_at = ? WHERE permit_id = ? AND state = 'reserved'`, at, permit.permit_id);
      }
      const unknown = this.all(`SELECT permit_id FROM permits WHERE state = 'admitted' AND host_instance != ?`, this.hostInstance);
      for (const permit of unknown) {
        this.run(`UPDATE permits SET state = 'settled', effect = 'unknown', settled_at = ? WHERE permit_id = ?`, at, permit.permit_id);
        this.run(`UPDATE budget_ledger SET state = 'unresolved', settled_at = ? WHERE permit_id = ? AND state = 'reserved'`, at, permit.permit_id);
      }
      const interrupted = this.all(`SELECT operation_id FROM operations WHERE outcome = 'in_progress'`);
      for (const operation of interrupted) this.run(`UPDATE operations SET outcome = 'reconciling', reason = 'host restarted during the operation', updated_at = ? WHERE operation_id = ?`, at, operation.operation_id);
      // Launch proofs of a previous instance can never register again.
      this.run(`UPDATE registration_proofs SET consumed_at = COALESCE(consumed_at, ?) WHERE host_instance != ?`, at, this.hostInstance);
      if (stale.length || unknown.length || interrupted.length) {
        this.audit('host.recovered', { invalidatedPermits: stale.map(p => p.permit_id), unknownEffects: unknown.map(p => p.permit_id), reconciling: interrupted.map(o => o.operation_id) });
      }
    });
    for (const row of this.all(`SELECT policy_id FROM policies WHERE state = 'revoked'`)) this.closedBarriers.add(row.policy_id);
    this.refreshBlock();
  }

  // Dispatch is blocked by any unresolved condition. Recomputed from the store so every path reports the same reason.
  refreshBlock() {
    const reasons = [];
    if (this.auditBroken) reasons.push(this.auditBroken);
    if (this.revocationFailure) reasons.push(this.revocationFailure);
    const reconciling = this.get(`SELECT COUNT(*) AS n FROM operations WHERE outcome = 'reconciling'`).n;
    if (reconciling) reasons.push(`${reconciling} operation(s) need reconciliation`);
    const orphaned = this.get(`SELECT COUNT(*) AS n FROM active_work WHERE state = 'active' AND host_instance != ?`, this.hostInstance).n;
    if (orphaned) reasons.push(`${orphaned} owned work item(s) from a previous host instance need native reconciliation`);
    if (this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='controller_queue'")) {
      const queued = this.get("SELECT COUNT(*) AS n FROM controller_queue WHERE state='reconciling'").n;
      if (queued) reasons.push(`${queued} controller step(s) need native reconciliation`);
    }
    this.dispatchBlocked = reasons.length ? reasons.join('; ') : null;
    return this.dispatchBlocked;
  }

  // Resolves a reconciling operation with evidence. Unknown outcomes stay reconciling; nothing is replayed.
  reconcileOperation(operationId, { outcome, reason, evidence }) {
    this.requireWritable();
    if (!['failed', 'verified', 'interrupted', 'blocked'].includes(outcome)) throw new HostError(400, 'invalid_request', 'Reconciliation records an established outcome.');
    if (!evidence) throw new HostError(400, 'invalid_request', 'Reconciliation needs evidence.');
    const operation = this.operationRow(operationId);
    if (operation.outcome !== 'reconciling') throw new HostError(409, 'conflict', `The operation is ${operation.outcome}.`);
    this.transaction(() => {
      this.run('UPDATE operations SET outcome = ?, reason = ?, evidence_json = ?, updated_at = ? WHERE operation_id = ?', outcome, reason,
        canonicalize({ ...JSON.parse(operation.evidence_json), reconciliation: evidence }), nowIsoFrom(this.time), operationId);
      this.audit('operation.reconciled', { operationId, outcome, reason }, { policyId: operation.policy_id });
    });
    this.refreshBlock();
    return { operationId, outcome, dispatchBlocked: this.dispatchBlocked };
  }

  // ---------- Status and history (readable while Deszo is down) ----------
  status(policyId) {
    const policy = this.policyRow(policyId);
    const decision = JSON.parse(policy.decision_json);
    const time = policy.state === 'active' ? remainingAuthority(policy, this.time) : { valid: false, remainingMs: 0, reason: policy.state };
    const used = this.usage(policy.session_id);
    return {
      policyId, sessionId: policy.session_id, revision: policy.revision, state: policy.state, valid: time.valid && !this.closedBarriers.has(policyId),
      reason: time.reason, remainingMs: time.remainingMs, issuedAt: policy.issued_at, expiresAt: policy.expires_at, limits: decision.limits, used,
      activeWork: this.all(`SELECT work_ref, permit_id, host_instance FROM active_work WHERE policy_id = ? AND state = 'active'`, policyId),
      assurance: this.assurance, readOnly: this.readOnly, dispatchBlocked: this.dispatchBlocked,
      recentDecisions: this.all('SELECT receipt_json FROM decisions WHERE policy_id = ? ORDER BY decided_at DESC LIMIT 20', policyId).map(r => JSON.parse(r.receipt_json)),
    };
  }

  sessionIndex(sessionId) {
    return {
      sessionId,
      policies: this.all('SELECT policy_id, revision, state, issued_at, expires_at, boot_id, supersedes_policy_id FROM policies WHERE session_id = ? ORDER BY revision', sessionId),
      decisions: this.all('SELECT d.receipt_json FROM decisions d JOIN policies p ON p.policy_id = d.policy_id WHERE p.session_id = ? ORDER BY d.decided_at', sessionId).map(r => JSON.parse(r.receipt_json)),
      operations: this.all('SELECT o.* FROM operations o JOIN policies p ON p.policy_id = o.policy_id WHERE p.session_id = ? ORDER BY o.created_at', sessionId),
      work: this.all('SELECT w.work_ref, w.permit_id, w.state, w.host_instance, w.created_at, w.released_at FROM active_work w JOIN policies p ON p.policy_id = w.policy_id WHERE p.session_id = ? ORDER BY w.created_at', sessionId),
      audit: this.all('SELECT sequence, event_type, payload_json, recorded_at, host_instance, boot_id FROM audit_events WHERE session_id = ? ORDER BY sequence', sessionId),
      usage: this.usage(sessionId),
      integrity: this.verifyAudit(),
    };
  }
}
