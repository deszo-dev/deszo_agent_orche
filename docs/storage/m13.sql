-- ADR-0007 Stage 1: Engine-owned attention, finite registrations and invocation/evidence receipts.
CREATE TABLE judge_sessions (
  id TEXT PRIMARY KEY,
  controller_session_id TEXT NOT NULL REFERENCES controller_sessions(id),
  owner_generation INTEGER NOT NULL CHECK(owner_generation > 0),
  registration_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  expires_at TEXT NOT NULL,
  max_invocations INTEGER NOT NULL CHECK(max_invocations BETWEEN 1 AND 3),
  invocations INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE judge_attention (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES judge_sessions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  request_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  package_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  subject_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  queue_reason TEXT,
  queued_at TEXT,
  created_at TEXT NOT NULL,
  response_due_at TEXT NOT NULL,
  queue_due_at TEXT NOT NULL,
  dispatchable_at TEXT,
  reason TEXT
);
CREATE INDEX judge_attention_queue ON judge_attention(session_id,state,created_at,id);
CREATE TABLE judge_invocations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES judge_sessions(id),
  attention_id TEXT NOT NULL UNIQUE REFERENCES judge_attention(id),
  owner_generation INTEGER NOT NULL,
  token_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  host_permit_id TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  wake_due_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  result_artifact_id TEXT REFERENCES artifacts(id)
);
CREATE UNIQUE INDEX judge_one_active_turn ON judge_invocations(session_id)
  WHERE state IN ('admitted','started','unknown');
CREATE TABLE judge_evidence_reads (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES judge_invocations(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE judge_decisions (
  id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL UNIQUE REFERENCES judge_attention(id),
  invocation_id TEXT NOT NULL REFERENCES judge_invocations(id),
  proposal_digest TEXT NOT NULL,
  receipt_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  applied_at TEXT NOT NULL
);
