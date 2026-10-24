-- Append-only native lifecycle/controller state. h1-h3 already exist in installed profiles.
ALTER TABLE controller_queue ADD COLUMN lease_owner TEXT;
ALTER TABLE controller_queue ADD COLUMN lease_sha256 TEXT;
ALTER TABLE controller_queue ADD COLUMN step_request_id TEXT;
CREATE INDEX controller_queue_by_policy_state ON controller_queue(policy_id,state,created_at);
CREATE TABLE installed_builds (
  build_id TEXT PRIMARY KEY,
  build_dir TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  tcb_digest TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  staged_at TEXT NOT NULL
);
CREATE TABLE data_profiles (
  profile_id TEXT PRIMARY KEY,
  profile_path TEXT NOT NULL UNIQUE,
  compatible_schema_min INTEGER NOT NULL,
  compatible_schema_max INTEGER NOT NULL,
  registration_json TEXT NOT NULL,
  registered_at TEXT NOT NULL
);
CREATE TABLE profile_restores (
  restore_id TEXT PRIMARY KEY,
  source_profile_id TEXT NOT NULL REFERENCES data_profiles(profile_id),
  destination_profile_id TEXT NOT NULL UNIQUE,
  source_digest TEXT NOT NULL,
  destination_digest TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','reconciling','verified','failed')),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
