-- P2 Parent/Repair coordination. Preserve the ADR-0008 activation contract while adding a narrowly
-- typed logical-continuation contract for explicitly authorized repairs. Incident identity,
-- Parent suspension intent, exact workflow bindings and the pending continuation decision live on
-- the existing relationship row; no second scheduler state is introduced.
CREATE TABLE run_links_v19 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('linked_repair')),
  parent_run_id TEXT NOT NULL REFERENCES runs(id),
  repair_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  parent_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repair_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  resume_node_instance_id TEXT NOT NULL,
  candidate_digest TEXT CHECK (candidate_digest IS NULL OR length(candidate_digest) = 64),
  checkpoint_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'repair_failed', 'repair_completed', 'repair_accepted', 'resumed', 'parent_stopped', 'blocked')),
  continuation_contract TEXT NOT NULL DEFAULT 'lifecycle' CHECK (continuation_contract IN ('lifecycle', 'logical_policy')),
  incident_id TEXT UNIQUE,
  parent_suspension_state TEXT NOT NULL DEFAULT 'suspended_for_repair'
    CHECK (parent_suspension_state IN ('suspension_requested', 'suspended_for_repair', 'resumable', 'resumed', 'stopped', 'blocked')),
  repair_outcome TEXT CHECK (repair_outcome IS NULL OR repair_outcome IN ('succeeded', 'failed', 'canceled', 'interrupted')),
  decision_status TEXT NOT NULL DEFAULT 'pending' CHECK (decision_status IN ('pending', 'accepted', 'rejected')),
  authorization_artifact_id TEXT REFERENCES artifacts(id),
  repair_result_node_instance_id TEXT,
  expected_repair_result_sha256 TEXT CHECK (expected_repair_result_sha256 IS NULL OR length(expected_repair_result_sha256) = 64),
  failed_node_retry TEXT CHECK (failed_node_retry IS NULL OR failed_node_retry IN ('explicit_safe', 'never')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_run_id <> repair_run_id),
  CHECK ((continuation_contract = 'logical_policy') = (incident_id IS NOT NULL)),
  CHECK (continuation_contract <> 'logical_policy' OR
    (authorization_artifact_id IS NOT NULL AND repair_result_node_instance_id IS NOT NULL
      AND expected_repair_result_sha256 IS NOT NULL AND failed_node_retry IS NOT NULL))
);
INSERT INTO run_links_v19 (
  id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id, resume_node_instance_id,
  candidate_digest, checkpoint_artifact_id, state, continuation_contract, incident_id, parent_suspension_state,
  repair_outcome, decision_status, authorization_artifact_id, repair_result_node_instance_id,
  expected_repair_result_sha256, failed_node_retry, created_at, updated_at
)
SELECT id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id, resume_node_instance_id,
  candidate_digest, checkpoint_artifact_id, state, 'lifecycle', NULL, 'suspended_for_repair',
  CASE WHEN state = 'repair_failed' THEN 'failed' WHEN state IN ('repair_completed','resumed') THEN 'succeeded' ELSE NULL END,
  CASE WHEN state = 'repair_failed' THEN 'rejected' WHEN state IN ('repair_completed','resumed') THEN 'accepted' ELSE 'pending' END,
  NULL, NULL, NULL, NULL, created_at, updated_at
FROM run_links;
DROP TABLE run_links;
ALTER TABLE run_links_v19 RENAME TO run_links;
CREATE INDEX run_links_by_state ON run_links(state);
CREATE INDEX run_links_by_incident ON run_links(incident_id);
CREATE UNIQUE INDEX one_active_linked_repair_per_parent ON run_links(parent_run_id)
  WHERE state IN ('open', 'repair_completed', 'repair_accepted');
