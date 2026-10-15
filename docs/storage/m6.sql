-- Reference migration 6 (external authoring API). Applied after m5.sql.
ALTER TABLE workflows ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE cache_pins ADD COLUMN incarnation_id TEXT;

CREATE TABLE runtime_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX workflow_changes_by_workflow ON workflow_changes(workflow_id, sequence);

CREATE TABLE cache_node_incarnations (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  node_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (workflow_id, node_id, incarnation_id)
);
CREATE UNIQUE INDEX one_active_cache_incarnation ON cache_node_incarnations(workflow_id, node_id) WHERE active = 1;

CREATE TABLE external_run_requests (
  request_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  request_json TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_snapshot_sha256 TEXT NOT NULL CHECK (length(workflow_snapshot_sha256) = 64),
  workspace_id TEXT NOT NULL,
  workspace_cwd_identity TEXT NOT NULL CHECK (length(workspace_cwd_identity) = 64),
  client_label TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  problem_json TEXT
);
CREATE INDEX external_run_requests_queue ON external_run_requests(state, created_at, request_id);

CREATE TABLE bridge_registrations (
  bridge_id TEXT PRIMARY KEY,
  client_provider TEXT NOT NULL CHECK (client_provider IN ('codex','claude','antigravity','other')),
  working_directory TEXT,
  mcp_config_path TEXT,
  isolation_mechanism TEXT,
  last_seen_at TEXT NOT NULL
);
