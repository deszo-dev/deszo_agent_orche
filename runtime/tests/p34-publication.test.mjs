import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonicalHash } from '../core/canonical.mjs';
import { MIGRATION_PATHS, Store } from '../core/store.mjs';
import { singleAgent, startTestRunner } from './helpers.mjs';
import { ownedPath } from './test-roots.mjs';

test('P34 migrates exact legacy definitions once without rewriting system workflows or historical Runs', async () => {
  const root = ownedPath(join(process.cwd(), '.deszo', 'tests', `p34-precutover-${randomUUID()}`));
  const legacy = new Store(root, { migrations: MIGRATION_PATHS.slice(0, 14).map(path => readFileSync(path, 'utf8')) });
  const valid = singleAgent({ id: 'legacy-valid', context: null });
  valid.view = { request: { x: 7, y: 13 }, answer: { x: 400, y: 13, label: 'historic layout' } };
  const invalid = singleAgent({ id: 'legacy-invalid', context: null });
  invalid.nodes.push(structuredClone(invalid.nodes[0]));
  const system = singleAgent({ id: 'protected-system', context: null });
  const createdAt = '2026-10-01T12:00:00.000Z';
  const validArtifact = legacy.putJson(valid);
  const invalidArtifact = legacy.putJson(invalid);
  const systemArtifact = legacy.putJson(system);
  const oldSettings = legacy.putJson({ schemaVersion: 1, historicSettings: 'preserved' });
  const cwd = join(root, 'workdirs', 'scratch', 'archive');
  mkdirSync(cwd, { recursive: true });
  const cwdHash = canonicalHash(cwd);
  legacy.run('INSERT INTO workspaces(id,cwd,cwd_identity,created_at,updated_at) VALUES(?,?,?,?,?)', 'archive', cwd, cwdHash, createdAt, createdAt);
  legacy.run(`INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at,kind,revision) VALUES(?,?,?,?,'user',5)`, valid.workflowId, validArtifact.artifactId, createdAt, createdAt);
  legacy.run(`INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at,kind,revision) VALUES(?,?,?,?,'user',2)`, invalid.workflowId, invalidArtifact.artifactId, createdAt, createdAt);
  legacy.run(`INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at,kind,revision) VALUES(?,?,?,?,'system',1)`, system.workflowId, systemArtifact.artifactId, createdAt, createdAt);
  const historicalRunId = randomUUID();
  legacy.run(`INSERT INTO runs(id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,last_sequence,created_at,kind,plan_artifact_id)
    VALUES(?,?,?,?,?,?,'succeeded',0,?,'workflow',NULL)`, historicalRunId, valid.workflowId, 'archive', validArtifact.artifactId,
  oldSettings.artifactId, canonicalHash(valid), createdAt);
  legacy.close();

  // Apply the DDL migration, then interrupt the one-time legacy import at its first Publication insert.
  // The import transaction must leave no partial versions and remain retryable on the next startup.
  const migratedSchema = new Store(root);
  migratedSchema.run(`CREATE TRIGGER test_abort_legacy_import BEFORE INSERT ON workflow_publications
    BEGIN SELECT RAISE(ABORT, 'injected legacy import failure'); END`);
  migratedSchema.close();
  await assert.rejects(startTestRunner({ root }), /injected legacy import failure/);
  const interrupted = new DatabaseSync(join(root, 'store', 'state.sqlite'));
  try {
    // The failure happens after every catalogued migration has applied, so the version is the catalogue's latest.
    assert.equal(interrupted.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, MIGRATION_PATHS.length);
    assert.equal(interrupted.prepare('SELECT legacy_import_complete FROM workflow_publication_state WHERE singleton = 1').get().legacy_import_complete, 0);
    assert.equal(interrupted.prepare('SELECT COUNT(*) AS n FROM workflow_publications').get().n, 0, 'the failed import left no partial Published Versions');
    assert.equal(interrupted.prepare('SELECT COUNT(*) AS n FROM workflow_changes').get().n, 0, 'the failed import left no partial change events');
    interrupted.exec('DROP TRIGGER test_abort_legacy_import');
  } finally { interrupted.close(); }

  let api = await startTestRunner({ root });
  try {
    const store = api.runner.engine.store;
    const migratedValid = store.get('SELECT * FROM workflow_publications WHERE workflow_id = ?', valid.workflowId);
    const migratedInvalid = store.get('SELECT * FROM workflow_publications WHERE workflow_id = ?', invalid.workflowId);
    assert.ok(migratedValid);
    assert.equal(migratedValid.version, 1);
    assert.equal(migratedValid.provenance, 'legacy-migration');
    assert.equal(migratedValid.authority_policy_version, 'designated-judge/1');
    assert.equal(migratedValid.definition_digest, validArtifact.sha256);
    assert.equal(migratedValid.runnable, 1);
    assert.deepEqual(store.readJson(migratedValid.snapshot_artifact_id), valid, 'the migrated JSON including view is byte-equivalent after canonical read');
    assert.equal(migratedInvalid.runnable, 0);
    assert.deepEqual(store.readJson(migratedInvalid.snapshot_artifact_id), invalid, 'invalid legacy bytes remain available without correction');
    assert.equal(store.get('SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', system.workflowId).n, 0);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM workflow_changes').n, 0, 'migration does not invent an owner Publication event');
    const historic = store.get('SELECT * FROM runs WHERE id = ?', historicalRunId);
    assert.equal(historic.workflow_snapshot_artifact_id, validArtifact.artifactId);
    assert.equal(historic.settings_artifact_id, oldSettings.artifactId);
    assert.equal(historic.created_at, createdAt);
    assert.equal(historic.state, 'succeeded');
    assert.equal(historic.published_version_id, null);
    assert.equal(historic.definition_digest, null);

    await api.workspace();
    const run = await api.call('POST', '/api/v2/runs', { requestId: randomUUID(), workflowId: invalid.workflowId,
      publishedVersionId: migratedInvalid.id, definitionDigest: migratedInvalid.definition_digest,
      workflowSnapshotSha256: invalidArtifact.sha256, workspaceId: 'main' });
    assert.equal(run.status, 409);
    assert.equal(run.body.code, 'published_version_not_runnable');
    const systemDraft = await api.call('PUT', `/api/v4/workflows/${system.workflowId}/draft`, { requestId: randomUUID(), workflow: system }, { headers: { 'If-None-Match': '*' } });
    assert.equal(systemDraft.status, 409, 'a system workflow row cannot become an ordinary public Draft');

    const derived = await api.call('POST', `/api/v4/workflows/${invalid.workflowId}/draft/from/1`, { requestId: randomUUID() }, { headers: { 'If-None-Match': '*' } });
    assert.equal(derived.status, 200);
    const corrected = structuredClone(derived.body.workflow);
    corrected.nodes.pop();
    const saved = await api.call('PUT', `/api/v4/workflows/${invalid.workflowId}/draft`, { requestId: randomUUID(), workflow: corrected }, { headers: { 'If-Match': derived.body.etag } });
    assert.equal(saved.status, 200);
    const validated = await api.call('POST', `/api/v4/workflows/${invalid.workflowId}/draft/validate`, {}, { headers: { 'If-Match': saved.body.etag } });
    assert.equal(validated.body.validation.valid, true);
    const correctedPublication = await api.call('POST', `/api/v4/workflows/${invalid.workflowId}/publish`, { requestId: randomUUID() }, { headers: { 'If-Match': saved.body.etag } });
    assert.equal(correctedPublication.body.version, 2);
    assert.equal(store.get('SELECT runnable FROM workflow_publications WHERE id = ?', migratedInvalid.id).runnable, 0, 'correction creates a new version and leaves history unchanged');
    assert.equal(store.get('SELECT published_version_id FROM runs WHERE id = ?', historicalRunId).published_version_id, null);
  } finally { await api.close(); }

  api = await startTestRunner({ root });
  try {
    const store = api.runner.engine.store;
    assert.equal(store.get('SELECT legacy_import_complete FROM workflow_publication_state WHERE singleton = 1').legacy_import_complete, 1);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', valid.workflowId).n, 1);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', invalid.workflowId).n, 2);
    const historic = store.get('SELECT * FROM runs WHERE id = ?', historicalRunId);
    assert.equal(historic.workflow_snapshot_artifact_id, validArtifact.artifactId);
    assert.equal(historic.settings_artifact_id, oldSettings.artifactId);
    assert.equal(historic.published_version_id, null);
    assert.equal(historic.definition_digest, null);
  } finally { await api.close(); }
});
