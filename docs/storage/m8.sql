-- Reference migration 8 (ADR-0002: execution evidence, control grants, incidents and audit exports).
-- Applied after m7.sql. Journal additions for these records are listed in journal-event-v2.schema.json.

-- One record per check or Agent attempt outcome, including outcomes that have no CheckReport.
CREATE TABLE execution_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','failed','canceled','timed_out','interrupted','spawn_failed','invalid_source','capture_failed','process_failed')),
  evidence_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX execution_evidence_by_attempt ON execution_evidence(attempt_id);

-- The termination proof a root Stop publishes once every owned member is accounted for.
CREATE TABLE termination_proofs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('stopped','termination_unconfirmed')),
  containment TEXT NOT NULL CHECK (containment IN ('none','windows-job')),
  control_mode TEXT NOT NULL CHECK (control_mode IN ('supervised','unsupervised')),
  requested_at TEXT NOT NULL,
  confirmed_at TEXT,
  proof_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX termination_proofs_by_run ON termination_proofs(run_id);

-- An opt-in controller session. The external token authenticates it; the session never carries a credential.
CREATE TABLE controller_sessions (
  id TEXT PRIMARY KEY,
  client_label TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- A supervision grant is requested for one workflow and workspace, approved first-party, and bound to the
-- single run it starts. The run's observer is armed before its first launch. run_id is null until bound.
CREATE TABLE control_grants (
  id TEXT PRIMARY KEY,
  controller_session_id TEXT NOT NULL REFERENCES controller_sessions(id),
  workflow_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workflow_snapshot_sha256 TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','active','revoked','expired','ended')),
  grant_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  observation_deadline_ms INTEGER NOT NULL CHECK (observation_deadline_ms > 0),
  escalation_deadline_ms INTEGER NOT NULL CHECK (escalation_deadline_ms > observation_deadline_ms),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  bound_at TEXT,
  last_ack_at TEXT,
  ack_cursor INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT
);
CREATE INDEX control_grants_by_run ON control_grants(run_id, state);
CREATE UNIQUE INDEX control_grants_one_active_per_run ON control_grants(run_id) WHERE state = 'active';

-- Acknowledgements record that the controller processed a semantic observation, with its lag.
CREATE TABLE observation_acks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  controller_session_id TEXT REFERENCES controller_sessions(id),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  event_timestamp TEXT,
  acknowledged_at TEXT NOT NULL,
  lag_ms INTEGER,
  UNIQUE(run_id, cursor, acknowledged_at)
);

-- Product incidents: an immutable initial observation plus append-only updates.
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('open','triaged','closed')),
  cause_status TEXT NOT NULL CHECK (cause_status IN ('suspected','confirmed')),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  title TEXT NOT NULL,
  component TEXT NOT NULL,
  category TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  initial_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  stop_outcome_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX incidents_by_state ON incidents(state, updated_at);
CREATE INDEX incidents_by_run ON incidents(run_id);

CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('observation','occurrence','triage','cause','closure')),
  authority TEXT NOT NULL CHECK (authority IN ('external','first-party','system')),
  body_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  UNIQUE(incident_id, seq)
);

-- Offline audit bundles for one run pinned to a journal sequence.
CREATE TABLE audit_exports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  profile TEXT NOT NULL CHECK (profile IN ('private-local','shareable')),
  pinned_sequence INTEGER NOT NULL CHECK (pinned_sequence >= 0),
  state TEXT NOT NULL CHECK (state IN ('complete','partial','failed')),
  manifest_artifact_id TEXT REFERENCES artifacts(id),
  directory TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_exports_by_run ON audit_exports(run_id);
