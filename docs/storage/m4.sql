-- Reference migration 4 (M5). Applied after m3.sql; the runtime backs up state.sqlite first.
-- Adds Map engine records, Map executions and their task projection.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE pipeline_records_v4 (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('ReviewRecord','GateCertificate','TaskResult','TaskReview','CheckReport','Candidate','Conflict','Triage','MapState')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
INSERT INTO pipeline_records_v4 SELECT id, run_id, kind, artifact_id, created_at FROM pipeline_records;
DROP TABLE pipeline_records;
ALTER TABLE pipeline_records_v4 RENAME TO pipeline_records;
CREATE INDEX pipeline_records_by_run ON pipeline_records(run_id, kind);
CREATE TABLE map_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  map_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  subject_id TEXT NOT NULL,
  template_fingerprint TEXT NOT NULL CHECK (length(template_fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('running','paused','finishing','implementation_complete','specification_revision_required','canceled','interrupted')),
  failed_cycles INTEGER NOT NULL CHECK (failed_cycles >= 0),
  max_failed_cycles INTEGER NOT NULL CHECK (max_failed_cycles >= 1),
  max_task_attempts INTEGER NOT NULL CHECK (max_task_attempts >= 1),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('verification_limit','task_attempt_limit','triage_unknown')),
  plan_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, attempt_id) REFERENCES attempts(run_id, id),
  CHECK ((state = 'paused') = (pause_reason IS NOT NULL))
);
CREATE INDEX map_executions_by_instance ON map_executions(run_id, map_instance_id);
CREATE TABLE map_tasks (
  execution_id TEXT NOT NULL REFERENCES map_executions(id),
  task_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','ready','running','awaiting_review','accepted','needs_changes','stale','blocked','canceled')),
  selected_result_id TEXT REFERENCES pipeline_records(id),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  data_json TEXT NOT NULL,
  PRIMARY KEY (execution_id, task_id),
  CHECK (state <> 'accepted' OR selected_result_id IS NOT NULL)
);
COMMIT;
PRAGMA foreign_keys = ON;
