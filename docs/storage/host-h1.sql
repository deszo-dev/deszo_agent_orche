-- Local Control Host store, migration h1 (ADR-0006). This database belongs to the trusted host, not to the
-- replaceable Deszo application: it lives outside workspaces, build outputs and the application store, and an
-- application-data restore never touches it. Rows are append-mostly; policy, revocation and receipts are never
-- rewritten by a restart.

CREATE TABLE host_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Credentials enrolled by the separately authorized installation. A worker or candidate cannot add one.
CREATE TABLE trusted_credentials (
  credential_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  label TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  enrolled_by TEXT NOT NULL,
  retired_at TEXT
);

-- Fresh, expiring, single-use challenges bound to one immutable proposed decision.
CREATE TABLE consent_challenges (
  challenge_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  audience TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  policy_id TEXT
);

-- Durable session policies. A new authorization (extension, widening, post-reboot) is a new row linked to the
-- one it follows; the original row and its expiry are never rewritten.
CREATE TABLE policies (
  policy_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  supersedes_policy_id TEXT REFERENCES policies(policy_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  decision_json TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  consent_json TEXT NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES consent_challenges(challenge_id),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  uptime_anchor_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','superseded')),
  revocation_generation INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX policies_by_session ON policies(session_id);

-- Shared aggregate ledger for a development session. Reservations stay counted until their effect is settled.
CREATE TABLE budget_ledger (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  permit_id TEXT,
  budget_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released','unresolved','carried')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX budget_ledger_by_session ON budget_ledger(session_id);

-- Every decision, approved or not, with the policy revision and revocation generation it was made under.
CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved','denied','pending')),
  receipt_json TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  UNIQUE (policy_id, request_id)
);

-- Permits are bounded permissions to request an effect. Admission is fenced by the revocation generation.
CREATE TABLE permits (
  permit_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  generation INTEGER NOT NULL,
  host_instance TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued','admitted','invalidated','settled')),
  issued_at TEXT NOT NULL,
  admitted_at TEXT,
  settled_at TEXT,
  effect TEXT CHECK (effect IN ('consumed','not_executed','unknown'))
);
CREATE INDEX permits_by_policy ON permits(policy_id, state);

-- Durable lifecycle operations: intent, observed effect and verified result are separate facts.
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('in_progress','reconciling','blocked','failed','verified','interrupted')),
  reason TEXT,
  intent_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  permit_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Hash-chained host audit. The chain detects accidental damage and reordering; in a same-user writable store it
-- is not an adversarial authenticity guarantee.
CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY,
  session_id TEXT,
  policy_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_sha256 TEXT NOT NULL,
  event_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  host_instance TEXT NOT NULL,
  boot_id TEXT NOT NULL
);
