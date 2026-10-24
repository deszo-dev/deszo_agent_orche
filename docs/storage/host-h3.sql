-- Native consent enrollment and evidence belong to the protected host, never the application store.
CREATE TABLE webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  public_key_jwk_json TEXT NOT NULL,
  user_sid TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  sign_count INTEGER NOT NULL,
  enrollment_evidence_json TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE native_consent_challenges (
  challenge_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('enroll','enroll_proof','policy')),
  policy_challenge_id TEXT,
  client_data_json TEXT NOT NULL,
  decision_digest TEXT,
  pending_credential_json TEXT,
  broker_identity_json TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  uptime_deadline_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  receipt_json TEXT
);
CREATE TABLE capability_receipts (
  capability TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE controller_queue (
  item_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  request_digest TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','reconciling','succeeded','failed','stopped')),
  step_index INTEGER NOT NULL DEFAULT 0,
  receipts_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
