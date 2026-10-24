import { DatabaseSync } from 'node:sqlite';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { canonicalBytes, canonicalize, parseStrictJson, sha256 } from './canonical.mjs';
import { assertValid } from './schemas.mjs';

export class CorruptionError extends Error {
  constructor(message) { super(message); this.code = 'corruption'; }
}

import { MIGRATION_PATHS } from './migrations.mjs';
export { MIGRATION_PATHS } from './migrations.mjs';
export const nowIso = () => new Date().toISOString();

// A reference script's transaction and pragma lines are applied by the runtime around it, so the
// schema change and its schema_migrations row commit together.
export function migrationBody(text) {
  return text.split(/\r?\n/).filter(line => !/^\s*(BEGIN|COMMIT|PRAGMA\s+\w+\s*=\s*\w+)\s*;\s*$/i.test(line)).join('\n');
}

export class Store extends EventEmitter {
  constructor(root, { migrations = null } = {}) {
    super();
    this.migrations = migrations;
    this.root = root;
    this.storeDir = join(root, 'store');
    this.objects = join(this.storeDir, 'objects');
    this.staging = join(this.storeDir, 'staging');
    this.workdirs = join(root, 'workdirs');
    for (const dir of [this.objects, this.staging, join(this.workdirs, 'scratch')]) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(this.storeDir, 'state.sqlite'));
    this.migrate();
    this.statements = new Map();
    this.inTransaction = false;
    this.pendingEvents = null;
    this.hasArtifactReferenceIndex = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_references'").get());
    if (this.hasArtifactReferenceIndex) this.backfillAttemptArtifactReferences();
  }

  migrate() {
    const steps = this.migrations || MIGRATION_PATHS.map(path => readFileSync(path, 'utf8'));
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    let version = 0;
    if (exists) {
      version = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0;
      if (version > steps.length) throw new Error(`Store schema version ${version} is newer than this runtime supports.`);
      if (version < steps.length) {
        // Back up before changing an existing store; stored events are never reinterpreted.
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        copyFileSync(join(this.storeDir, 'state.sqlite'), join(this.storeDir, `state.v${version}.${Date.now()}.bak.sqlite`));
      }
    }
    for (let index = version; index < steps.length; index++) {
      // One transaction per migration: DDL, data copy and the applied-version row are atomic.
      this.db.exec('PRAGMA foreign_keys = OFF');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migrationBody(steps[index]));
        this.db.prepare('INSERT INTO schema_migrations(version, sha256, applied_at) VALUES (?, ?, ?)').run(index + 1, sha256(Buffer.from(steps[index], 'utf8')), nowIso());
        if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign-key check failed');
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* The failure already ended the transaction. */ }
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.close();
        throw new Error(`Store migration ${index + 1} failed and was rolled back; the store is unchanged at version ${index}${index ? ' (a backup was written beside it)' : ''}: ${error.message}`);
      }
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('The store failed its foreign-key check after migration.');
  }

  sql(text) {
    if (!this.statements.has(text)) this.statements.set(text, this.db.prepare(text));
    return this.statements.get(text);
  }
  get(text, ...params) { return this.sql(text).get(...params); }
  all(text, ...params) { return this.sql(text).all(...params); }
  run(text, ...params) { return this.sql(text).run(...params); }

  indexArtifactReferences(artifactId, bytes) {
    if (!this.hasArtifactReferenceIndex || this.get('SELECT artifact_id FROM artifact_reference_indexed WHERE artifact_id = ?', artifactId)) return;
    let value = null;
    try { value = parseStrictJson(Buffer.from(bytes).toString('utf8')); } catch { /* Not every application/json artifact is a JSON reference envelope. */ }
    const references = [];
    const visit = (item, path = []) => {
      if (Array.isArray(item)) return item.forEach((child, index) => visit(child, [...path, index]));
      if (!item || typeof item !== 'object') return;
      if (typeof item.artifactId === 'string') references.push([item.artifactId, canonicalize(path)]);
      for (const [key, child] of Object.entries(item)) visit(child, [...path, key]);
    };
    if (value !== null) visit(value);
    this.transaction(() => {
      for (const [targetId, pathJson] of references)
        this.run('INSERT OR IGNORE INTO artifact_references(parent_artifact_id,referenced_artifact_id,path_json) VALUES(?,?,?)', artifactId, targetId, pathJson);
      this.run('INSERT OR IGNORE INTO artifact_reference_indexed(artifact_id) VALUES(?)', artifactId);
    });
  }

  backfillAttemptArtifactReferences() {
    const missing = this.all(`SELECT DISTINCT source.artifact_id FROM (
      SELECT inputs_artifact_id AS artifact_id FROM attempts WHERE inputs_artifact_id IS NOT NULL
      UNION ALL SELECT invocation_artifact_id FROM attempts WHERE invocation_artifact_id IS NOT NULL
      UNION ALL SELECT outputs_artifact_id FROM attempts WHERE outputs_artifact_id IS NOT NULL
    ) source LEFT JOIN artifact_reference_indexed ref_index ON ref_index.artifact_id = source.artifact_id
      WHERE ref_index.artifact_id IS NULL`);
    for (const { artifact_id: artifactId } of missing) {
      let bytes = Buffer.alloc(0);
      try { bytes = this.readBytes(artifactId).bytes; } catch { /* Preserve availability; unreadable envelopes cannot yield references. */ }
      this.indexArtifactReferences(artifactId, bytes);
    }
  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    const pending = this.pendingEvents = [];
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.inTransaction = false; this.pendingEvents = null;
      for (const envelope of pending) this.emit('event', envelope);
      return result;
    } catch (error) {
      this.inTransaction = false; this.pendingEvents = null;
      try { this.db.exec('ROLLBACK'); } catch { /* The failed statement may already have ended the transaction. */ }
      throw error;
    }
  }

  // Publish immutable bytes: stage, flush, hash, atomic rename, then reference.
  putBytes(bytes, mediaType) {
    const digest = sha256(bytes);
    const existing = this.get('SELECT id FROM artifacts WHERE sha256 = ? AND media_type = ?', digest, mediaType);
    const relative = `objects/${digest.slice(0, 2)}/${digest}`;
    const target = join(this.storeDir, relative);
    if (!existsSync(target)) {
      mkdirSync(join(this.objects, digest.slice(0, 2)), { recursive: true });
      const temporary = join(this.staging, randomUUID());
      const handle = openSync(temporary, 'w');
      try { writeSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
      try { renameSync(temporary, target); }
      catch (error) { rmSync(temporary, { force: true }); if (!existsSync(target)) throw error; }
    }
    if (existing) {
      if (mediaType === 'application/json') this.indexArtifactReferences(existing.id, bytes);
      return { artifactId: existing.id, sha256: digest };
    }
    const artifactId = randomUUID();
    this.run('INSERT INTO artifacts(id, sha256, byte_size, media_type, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      artifactId, digest, bytes.length, mediaType, relative, nowIso());
    if (mediaType === 'application/json') this.indexArtifactReferences(artifactId, bytes);
    return { artifactId, sha256: digest };
  }
  putJson(value) { return this.putBytes(canonicalBytes(value), 'application/json'); }
  putText(text) { return this.putBytes(Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8'); }

  artifactRow(artifactId) { return this.get('SELECT * FROM artifacts WHERE id = ?', artifactId); }

  readBytes(artifactId) {
    const row = this.artifactRow(artifactId);
    if (!row) throw new CorruptionError(`Artifact ${artifactId} is not recorded.`);
    let bytes;
    try { bytes = readFileSync(join(this.storeDir, row.relative_path)); }
    catch { throw new CorruptionError(`Artifact ${artifactId} is missing from the object store.`); }
    if (bytes.length !== row.byte_size || sha256(bytes) !== row.sha256) throw new CorruptionError(`Artifact ${artifactId} failed digest verification.`);
    return { bytes, row };
  }
  readJson(artifactId) { return parseStrictJson(this.readBytes(artifactId).bytes.toString('utf8')); }
  readText(artifactId) { return this.readBytes(artifactId).bytes.toString('utf8'); }
  verifyRef(ref) {
    const { row } = this.readBytes(ref.artifactId);
    if (row.sha256 !== ref.sha256) throw new CorruptionError(`Artifact ${ref.artifactId} digest does not match its reference.`);
    return ref;
  }

  // Inline immutable journal envelopes; the caller's transaction also updates projections.
  appendEvents(runId, events) {
    return this.transaction(() => {
      const run = this.get('SELECT last_sequence, journal_version FROM runs WHERE id = ?', runId);
      const version = run.journal_version;
      let sequence = run.last_sequence;
      const written = [];
      for (const event of events) {
        sequence += 1;
        const envelope = {
          schemaVersion: version, id: randomUUID(), runId, sequence, timestamp: event.timestamp || nowIso(),
          nodeInstanceId: event.nodeInstanceId ?? null, attemptId: event.attemptId ?? null,
          type: event.type, payload: event.payload,
        };
        assertValid(version === 1 ? 'journal-event.schema.json' : 'journal-event-v2.schema.json', null, envelope, `Journal event ${event.type}`);
        const json = canonicalize(envelope);
        const bytes = Buffer.from(json, 'utf8');
        this.run(`INSERT INTO journal_events(run_id, sequence, id, event_type, node_instance_id, attempt_id, envelope_json, envelope_sha256, envelope_byte_size, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, runId, sequence, envelope.id, envelope.type, envelope.nodeInstanceId, envelope.attemptId, json, sha256(bytes), bytes.length, envelope.timestamp);
        written.push(envelope);
      }
      this.run('UPDATE runs SET last_sequence = ? WHERE id = ?', sequence, runId);
      this.pendingEvents.push(...written);
      return written;
    });
  }

  readEvents(runId, afterSequence = 0) {
    return this.all('SELECT envelope_json, envelope_sha256, envelope_byte_size FROM journal_events WHERE run_id = ? AND sequence > ? ORDER BY sequence', runId, afterSequence)
      .map(row => {
        const bytes = Buffer.from(row.envelope_json, 'utf8');
        if (bytes.length !== row.envelope_byte_size || sha256(bytes) !== row.envelope_sha256) throw new CorruptionError(`Journal event of run ${runId} failed digest verification.`);
        return parseStrictJson(row.envelope_json);
      });
  }

  readEventsPage(runId, afterSequence = 0, limit = 100) {
    return this.all('SELECT envelope_json, envelope_sha256, envelope_byte_size FROM journal_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?', runId, afterSequence, limit + 1)
      .map(row => {
        const bytes = Buffer.from(row.envelope_json, 'utf8');
        if (bytes.length !== row.envelope_byte_size || sha256(bytes) !== row.envelope_sha256) throw new CorruptionError(`Journal event of run ${runId} failed digest verification.`);
        return parseStrictJson(row.envelope_json);
      });
  }

  recordTaskAssessment(assessment) {
    const { artifactId } = this.putJson(assessment);
    this.run(
      `INSERT INTO task_assessments(id, assessment_run_id, business_request_id, source_snapshot_hash, assessment_artifact_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      assessment.assessmentId,
      assessment.assessmentRunId,
      assessment.businessRequestId,
      assessment.sourceSnapshotHash,
      artifactId,
      assessment.createdAt || nowIso()
    );
    return { assessmentId: assessment.assessmentId, artifactId };
  }

  // Supersession and insertion commit together (A4). An identical retry of a stored revision returns its original
  // receipt; a different document under an existing revision id is refused and leaves the active revision in place.
  recordExecutionPlan(plan, assessmentId, status = 'active') {
    return this.transaction(() => {
      const { artifactId } = this.putJson(plan);
      const stored = this.get('SELECT plan_artifact_id FROM execution_plans WHERE id = ? AND plan_revision_id = ?', plan.planId, plan.planRevisionId);
      if (stored) {
        if (stored.plan_artifact_id !== artifactId) {
          throw new Error(`Execution plan revision ${plan.planRevisionId} is already stored with different content.`);
        }
        return { planId: plan.planId, planRevisionId: plan.planRevisionId, artifactId, replayed: true };
      }
      if (status === 'active') {
        this.run(`UPDATE execution_plans SET status = 'superseded' WHERE id = ? AND status = 'active' AND plan_revision_id <> ?`, plan.planId, plan.planRevisionId);
      }
      this.run(
        `INSERT INTO execution_plans(id, plan_revision_id, assessment_id, execution_run_id, policy_version, delivery_boundary, plan_fingerprint, plan_artifact_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        plan.planId,
        plan.planRevisionId,
        assessmentId,
        plan.executionRunId ?? null,
        plan.policyVersion,
        plan.deliveryBoundary,
        plan.planFingerprint,
        artifactId,
        status,
        plan.createdAt || nowIso()
      );
      return { planId: plan.planId, planRevisionId: plan.planRevisionId, artifactId, replayed: false };
    });
  }

  recordAcceptanceRecord(record, runId) {
    const { artifactId } = this.putJson(record);
    this.run(
      `INSERT INTO acceptance_records(id, run_id, boundary, subject_id, candidate_digest, overall_status, record_artifact_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.recordId,
      runId,
      record.deliveryBoundary,
      record.subjectId,
      record.candidateDigest,
      record.overallStatus,
      artifactId,
      record.evaluatedAt || nowIso()
    );
    return { recordId: record.recordId, artifactId };
  }

  recordBranchDelivery(result, runId) {
    const { artifactId } = this.putJson(result);
    this.run(
      `INSERT INTO branch_deliveries(id, run_id, delivery_plan_id, target_branch_ref, commit_id, status, result_artifact_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      result.deliveryResultId,
      runId,
      result.deliveryPlanId,
      result.targetBranchRef,
      result.verifiedCommitId ?? null,
      result.status,
      artifactId,
      result.completedAt || nowIso()
    );
    return { deliveryResultId: result.deliveryResultId, artifactId };
  }

  close() { this.db.close(); }
}
