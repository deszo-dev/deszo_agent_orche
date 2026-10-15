-- Reference M1 schema v0.8. Documentation only; not an installed migration.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  applied_at TEXT NOT NULL
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (sha256, media_type)
);
CREATE TABLE application_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  settings_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  cwd_identity TEXT NOT NULL CHECK (length(cwd_identity) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  snapshot_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  workflow_snapshot_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  settings_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  execution_hash TEXT NOT NULL CHECK (length(execution_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('queued','running','draining','stopping','succeeded','failed','canceled','interrupted')),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_run_per_workspace ON runs(workspace_id)
  WHERE state IN ('queued','running','draining','stopping');
CREATE INDEX run_history ON runs(created_at DESC,id DESC);
CREATE INDEX workspace_run_history ON runs(workspace_id,created_at DESC,id DESC);
CREATE INDEX workflow_listing ON workflows(created_at DESC,id DESC);
CREATE INDEX workspace_listing ON workspaces(created_at DESC,id DESC);
CREATE TABLE node_instances (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','waiting','running','succeeded','failed','canceled','blocked','interrupted')),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, node_id)
);
CREATE TABLE context_bindings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('codex','claude','antigravity')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  account_identity TEXT NOT NULL,
  cwd_identity TEXT NOT NULL CHECK (length(cwd_identity) = 64),
  configuration_hash TEXT NOT NULL CHECK (length(configuration_hash) = 64),
  native_session_hash TEXT,
  binding_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  state TEXT NOT NULL CHECK (state IN ('unbound','ready','writing','needs_review','unavailable')),
  updated_at TEXT NOT NULL
);
-- Native identity is shared; run/Context use and mode are separate.
CREATE UNIQUE INDEX native_binding_identity ON context_bindings(provider,account_identity,native_session_hash)
  WHERE native_session_hash IS NOT NULL;
CREATE TABLE run_context_bindings (
  run_id TEXT NOT NULL REFERENCES runs(id),
  context_node_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('new','continue')),
  binding_id TEXT NOT NULL REFERENCES context_bindings(id),
  PRIMARY KEY (run_id,context_node_id)
);
-- A binding can originate in one New mapping; later Continue mappings reuse it.
CREATE UNIQUE INDEX one_new_context_origin ON run_context_bindings(binding_id)
  WHERE mode = 'new';
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_instance_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  state TEXT NOT NULL CHECK (state IN ('scheduled','waiting','running','succeeded','failed','canceled','blocked','interrupted')),
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
CREATE TABLE journal_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  node_instance_id TEXT,
  attempt_id TEXT,
  envelope_json TEXT NOT NULL,
  envelope_sha256 TEXT NOT NULL CHECK (length(envelope_sha256) = 64),
  envelope_byte_size INTEGER NOT NULL CHECK (
    envelope_byte_size >= 1 AND envelope_byte_size = length(CAST(envelope_json AS BLOB))
  ),
  timestamp TEXT NOT NULL,
  PRIMARY KEY (run_id,sequence),
  FOREIGN KEY (run_id,node_instance_id) REFERENCES node_instances(run_id,id),
  FOREIGN KEY (run_id,node_instance_id,attempt_id) REFERENCES attempts(run_id,node_instance_id,id),
  CHECK (attempt_id IS NULL OR node_instance_id IS NOT NULL)
);
CREATE TABLE command_receipts (
  request_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  response_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE TABLE resource_locks (
  resource_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT,
  acquired_at TEXT NOT NULL,
  FOREIGN KEY (run_id,attempt_id) REFERENCES attempts(run_id,id)
);
