-- Process Custody (PoC). The Engine's durable binding of one committed attempt to the CLI its Lifecycle Host owns.
-- The Host keeps the process, its output spool and its terminal record; this row only lets a later Engine find them.
-- The emergency credential is stored as the Engine's own copy so that an Engine can stop the CLI after a restart;
-- the launch permit is never stored here. Rows are written before launch and never change identity.
CREATE TABLE attempt_custody (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  custody_id TEXT NOT NULL UNIQUE,
  emergency_token TEXT NOT NULL CHECK (length(emergency_token) = 64),
  created_at TEXT NOT NULL
);

CREATE INDEX attempt_custody_run ON attempt_custody(run_id);
