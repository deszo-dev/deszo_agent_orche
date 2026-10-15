-- Reference migration 3 (M3/M4). Applied after m2.sql; the runtime backs up state.sqlite first.
-- Adds reused/skipped attempt states, run kinds and plans, system workflows, cache pins and pipeline records.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE node_instances_v3 (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','waiting','running','succeeded','failed','canceled','blocked','interrupted','reused','skipped')),
  PRIMARY KEY (run_id, id)
);
INSERT INTO node_instances_v3 SELECT run_id, id, node_id, node_type, state FROM node_instances;
DROP TABLE node_instances;
ALTER TABLE node_instances_v3 RENAME TO node_instances;
CREATE INDEX node_instances_by_node ON node_instances(run_id, node_id);
CREATE TABLE attempts_v3 (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_instance_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  state TEXT NOT NULL CHECK (state IN ('scheduled','waiting','running','succeeded','failed','canceled','blocked','interrupted','reused','skipped')),
  context_binding_id TEXT REFERENCES context_bindings(id),
  inputs_artifact_id TEXT REFERENCES artifacts(id),
  invocation_artifact_id TEXT REFERENCES artifacts(id),
  outputs_artifact_id TEXT REFERENCES artifacts(id),
  process_id INTEGER CHECK (process_id IS NULL OR process_id > 0),
  process_start_identity TEXT,
  supervisor_generation TEXT,
  exit_code INTEGER,
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (run_id,node_instance_id) REFERENCES node_instances(run_id,id),
  UNIQUE (run_id,node_instance_id,ordinal),
  UNIQUE (run_id,node_instance_id,id),
  UNIQUE (run_id,id)
);
INSERT INTO attempts_v3 SELECT id, run_id, node_instance_id, ordinal, state, context_binding_id, inputs_artifact_id, invocation_artifact_id, outputs_artifact_id,
  process_id, process_start_identity, supervisor_generation, exit_code, started_at, ended_at FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_v3 RENAME TO attempts;
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'workflow' CHECK (kind IN ('workflow','chat'));
ALTER TABLE runs ADD COLUMN plan_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE workflows ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system'));
CREATE TABLE cache_pins (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  node_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES runs(id),
  source_attempt_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, node_id),
  FOREIGN KEY (source_run_id, source_attempt_id) REFERENCES attempts(run_id, id)
);
CREATE TABLE pipeline_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('ReviewRecord','GateCertificate')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
COMMIT;
PRAGMA foreign_keys = ON;
