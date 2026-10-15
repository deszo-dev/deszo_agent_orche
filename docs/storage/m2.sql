-- Reference migration 2 (M2). Applied after m1.sql; the runtime backs up state.sqlite first.
-- Rebuilds runs so its state CHECK and active-run index admit waiting_for_user, and node_instances
-- so scoped loop instances can repeat a node ID.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE runs_v2 (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  workflow_snapshot_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  settings_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  execution_hash TEXT NOT NULL CHECK (length(execution_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('queued','running','draining','waiting_for_user','stopping','succeeded','failed','canceled','interrupted')),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at TEXT NOT NULL,
  journal_version INTEGER NOT NULL DEFAULT 2 CHECK (journal_version IN (1, 2))
);
INSERT INTO runs_v2(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at, journal_version)
  SELECT id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at, 1 FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;
CREATE UNIQUE INDEX one_active_run_per_workspace ON runs(workspace_id)
  WHERE state IN ('queued','running','draining','waiting_for_user','stopping');
CREATE INDEX run_history ON runs(created_at DESC,id DESC);
CREATE INDEX workspace_run_history ON runs(workspace_id,created_at DESC,id DESC);
-- Scoped body instances repeat a node ID per iteration; identity is (run_id, id) only.
CREATE TABLE node_instances_v2 (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','waiting','running','succeeded','failed','canceled','blocked','interrupted')),
  PRIMARY KEY (run_id, id)
);
INSERT INTO node_instances_v2(run_id, id, node_id, node_type, state) SELECT run_id, id, node_id, node_type, state FROM node_instances;
DROP TABLE node_instances;
ALTER TABLE node_instances_v2 RENAME TO node_instances;
CREATE INDEX node_instances_by_node ON node_instances(run_id, node_id);
CREATE TABLE loop_executions (
  run_id TEXT NOT NULL REFERENCES runs(id),
  loop_node_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','paused','finished','failed','canceled','interrupted')),
  iteration INTEGER NOT NULL CHECK (iteration >= 1),
  max_iterations INTEGER NOT NULL CHECK (max_iterations BETWEEN 1 AND 50),
  max_active_minutes INTEGER NOT NULL CHECK (max_active_minutes BETWEEN 1 AND 1440),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('iteration_limit','time_limit','body_failure','stopped')),
  CHECK ((state = 'paused') = (pause_reason IS NOT NULL)),
  PRIMARY KEY (run_id, loop_node_id),
  FOREIGN KEY (run_id, attempt_id) REFERENCES attempts(run_id, id)
);
CREATE TABLE loop_iterations (
  run_id TEXT NOT NULL,
  loop_node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL CHECK (iteration >= 1),
  value_json TEXT NOT NULL,
  feedback_json TEXT NOT NULL,
  candidate_json TEXT,
  decision_json TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('running','continued','finished','paused','canceled','failed','interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (run_id, loop_node_id, iteration),
  FOREIGN KEY (run_id, loop_node_id) REFERENCES loop_executions(run_id, loop_node_id)
);
COMMIT;
PRAGMA foreign_keys = ON;
