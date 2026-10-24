-- Durable external incident delivery. This outbox is host-owned; application rollback cannot erase it.
CREATE TABLE incident_outbox (
  request_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  item_id TEXT,
  profile_id TEXT NOT NULL,
  store_id TEXT,
  run_id TEXT,
  observation_json TEXT NOT NULL,
  observation_digest TEXT NOT NULL,
  termination_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','registered')),
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX incident_outbox_pending ON incident_outbox(state,created_at);
