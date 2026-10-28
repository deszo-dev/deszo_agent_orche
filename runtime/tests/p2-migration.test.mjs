// P2 migration proof: populated ADR-0008 links migrate without losing legacy lifecycle data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../core/store.mjs';
import { MIGRATION_PATHS } from '../core/migrations.mjs';
import { ownedDir } from './test-roots.mjs';

test('P2-M19: existing linked-repair rows survive the additive coordination migration', () => {
  const scratchRoot = resolve(import.meta.dirname, '../../.deszo/tests');
  mkdirSync(scratchRoot, { recursive: true });
  const root = ownedDir(join(scratchRoot, 'p2-m19-'));
  let oldStore = null;
  let migratedStore = null;
  try {
    const version18 = MIGRATION_PATHS.slice(0, -2).map(path => readFileSync(path, 'utf8'));
    oldStore = new Store(root, { migrations: version18 });
    const at = new Date().toISOString();
    const parentWorkspaceId = 'legacy-parent-workspace';
    const repairWorkspaceId = 'legacy-repair-workspace';
    const parentWorkflowId = 'legacy-parent-workflow';
    const repairWorkflowId = 'legacy-repair-workflow';
    const parentRunId = '00000000-0000-4000-8000-000000000001';
    const repairRunId = '00000000-0000-4000-8000-000000000002';
    const linkId = '00000000-0000-4000-8000-000000000003';
    const workspaceIdentity = 'a'.repeat(64);
    const candidateDigest = 'b'.repeat(64);
    const definitionDigest = 'c'.repeat(64);
    const executionHash = 'd'.repeat(64);
    const parentPublicationId = '00000000-0000-4000-8000-000000000004';
    const repairPublicationId = '00000000-0000-4000-8000-000000000005';
    const workflowArtifact = oldStore.putText('legacy workflow snapshot');
    const settingsArtifact = oldStore.putText('legacy run settings');
    const checkpointArtifact = oldStore.putText('legacy continuation checkpoint');
    oldStore.run('INSERT INTO workspaces(id,cwd,cwd_identity,created_at,updated_at) VALUES(?,?,?,?,?)', parentWorkspaceId, 'C:/legacy-parent', workspaceIdentity, at, at);
    oldStore.run('INSERT INTO workspaces(id,cwd,cwd_identity,created_at,updated_at) VALUES(?,?,?,?,?)', repairWorkspaceId, 'C:/legacy-repair', workspaceIdentity, at, at);
    oldStore.run('INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at) VALUES(?,?,?,?)', parentWorkflowId, workflowArtifact.artifactId, at, at);
    oldStore.run('INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at) VALUES(?,?,?,?)', repairWorkflowId, workflowArtifact.artifactId, at, at);
    for (const [workflowId, publicationId] of [[parentWorkflowId, parentPublicationId], [repairWorkflowId, repairPublicationId]])
      oldStore.run(`INSERT INTO workflow_publications(id,workflow_id,version,snapshot_artifact_id,definition_digest,execution_hash,authority_policy_version,
        provenance,runnable,validation_json,source_draft_revision,created_at) VALUES(?,?,1,?,?,?,'legacy-policy','legacy-migration',1,'{}',NULL,?)`,
        publicationId, workflowId, workflowArtifact.artifactId, definitionDigest, executionHash, at);
    for (const [runId, workflowId, workspaceId, state, publicationId] of [
      [parentRunId, parentWorkflowId, parentWorkspaceId, 'waiting_for_user', parentPublicationId],
      [repairRunId, repairWorkflowId, repairWorkspaceId, 'running', repairPublicationId],
    ]) oldStore.run(`INSERT INTO runs(id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,created_at,published_version_id,definition_digest)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, runId, workflowId, workspaceId, workflowArtifact.artifactId, settingsArtifact.artifactId, executionHash, state, at, publicationId, definitionDigest);
    oldStore.run(`INSERT INTO run_links(id,kind,parent_run_id,repair_run_id,parent_workspace_id,repair_workspace_id,resume_node_instance_id,
      candidate_digest,checkpoint_artifact_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'open',?,?)`,
      linkId, 'linked_repair', parentRunId, repairRunId, parentWorkspaceId, repairWorkspaceId, 'failed-node', candidateDigest, checkpointArtifact.artifactId, at, at);
    oldStore.close();
    oldStore = null;

    migratedStore = new Store(root);
    const link = migratedStore.get('SELECT * FROM run_links WHERE id = ?', linkId);
    assert.equal(link.continuation_contract, 'lifecycle');
    assert.equal(link.incident_id, null, 'legacy lifecycle links do not acquire a fabricated P2 incident');
    assert.equal(link.state, 'open');
    assert.equal(link.parent_run_id, parentRunId);
    assert.equal(link.repair_run_id, repairRunId);
    assert.equal(link.candidate_digest, candidateDigest);
    assert.equal(link.checkpoint_artifact_id, checkpointArtifact.artifactId);
    assert.equal(link.acceptance_mode, 'expected_digest', 'legacy linked Repair rows do not acquire adaptive Judge approval authority');
    assert.equal(link.decision_status, 'pending');
    assert.equal(migratedStore.get('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').version, MIGRATION_PATHS.length);
    assert.equal(migratedStore.get("SELECT name FROM sqlite_master WHERE type='table' AND name='failure_outcomes'").name, 'failure_outcomes');
    assert.deepEqual(migratedStore.all('PRAGMA foreign_key_check'), []);
  } finally {
    oldStore?.close();
    migratedStore?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
