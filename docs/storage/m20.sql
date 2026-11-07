-- P3 durable typed execution outcomes. The journal remains the append-only history; this per-Run
-- projection supplies stable identity, deduplication and a bounded ordered read for future consumers.
CREATE TABLE failure_outcomes (
  outcome_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT UNIQUE REFERENCES attempts(id),
  node_instance_id TEXT,
  first_sequence INTEGER,
  latest_sequence INTEGER,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  outcome_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id, node_instance_id, attempt_id) REFERENCES attempts(run_id, node_instance_id, id),
  CHECK (first_sequence IS NULL OR first_sequence >= 1),
  CHECK (latest_sequence IS NULL OR latest_sequence >= 1),
  CHECK ((attempt_id IS NULL) = (node_instance_id IS NULL))
);
CREATE INDEX failure_outcomes_by_run_sequence ON failure_outcomes(run_id, latest_sequence, outcome_id);
