-- Reference migration 7 (indexed artifact provenance). Applied after m6.sql.
CREATE TABLE artifact_reference_indexed (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE
);

CREATE TABLE artifact_references (
  parent_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  referenced_artifact_id TEXT NOT NULL,
  path_json TEXT NOT NULL,
  PRIMARY KEY (parent_artifact_id, referenced_artifact_id, path_json)
);
CREATE INDEX artifact_references_by_target ON artifact_references(referenced_artifact_id, parent_artifact_id);

CREATE INDEX attempt_inputs_artifact ON attempts(inputs_artifact_id);
CREATE INDEX attempt_invocation_artifact ON attempts(invocation_artifact_id);
CREATE INDEX attempt_outputs_artifact ON attempts(outputs_artifact_id);
CREATE INDEX run_workflow_snapshot_artifact ON runs(workflow_snapshot_artifact_id);
