-- Reference migration 5 (M6). Applied after m4.sql; the runtime backs up state.sqlite first.
-- Adds the carry record kinds; carried selections keep referencing their original TaskResult records.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE pipeline_records_v5 (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('ReviewRecord','GateCertificate','ReviewCarry','TaskResult','TaskReview','CheckReport','Candidate','Conflict','Triage','MapState','TaskCarry')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
INSERT INTO pipeline_records_v5 SELECT id, run_id, kind, artifact_id, created_at FROM pipeline_records;
DROP TABLE pipeline_records;
ALTER TABLE pipeline_records_v5 RENAME TO pipeline_records;
CREATE INDEX pipeline_records_by_run ON pipeline_records(run_id, kind);
COMMIT;
PRAGMA foreign_keys = ON;
