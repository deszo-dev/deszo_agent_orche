-- Managed task execution uses ordinary run/node/attempt identities and immutable state revisions.
CREATE TABLE managed_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  state TEXT NOT NULL CHECK (state IN ('running','paused','completed','canceled','interrupted')),
  state_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX managed_tasks_by_run ON managed_tasks(run_id, node_instance_id);
CREATE TABLE task_work (
  id TEXT PRIMARY KEY,
  task_execution_id TEXT NOT NULL REFERENCES managed_tasks(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  category TEXT NOT NULL,
  attempt_cost INTEGER NOT NULL CHECK (attempt_cost >= 0),
  started_at TEXT NOT NULL,
  launched_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  evidence_artifact_id TEXT REFERENCES artifacts(id)
);
CREATE INDEX task_work_by_execution ON task_work(task_execution_id);
CREATE TABLE task_evidence (
  id TEXT PRIMARY KEY,
  task_execution_id TEXT NOT NULL REFERENCES managed_tasks(id),
  plan_revision_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  record_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  content_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE TABLE delivery_operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_execution_id TEXT NOT NULL REFERENCES managed_tasks(id),
  intent_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  phase TEXT NOT NULL,
  receipt_artifact_id TEXT REFERENCES artifacts(id),
  updated_at TEXT NOT NULL
);

-- Preserve existing delivery receipts while allowing an explicitly uncertain publication outcome.
ALTER TABLE branch_deliveries RENAME TO branch_deliveries_m9;
CREATE TABLE branch_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  delivery_plan_id TEXT NOT NULL,
  target_branch_ref TEXT NOT NULL,
  commit_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('READY_FOR_MERGE','delivery_failed','precondition_failed','verification_failed','ref_conflict','stopped','publication_uncertain')),
  result_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
INSERT INTO branch_deliveries SELECT * FROM branch_deliveries_m9;
DROP TABLE branch_deliveries_m9;
CREATE INDEX branch_deliveries_by_run ON branch_deliveries(run_id);
