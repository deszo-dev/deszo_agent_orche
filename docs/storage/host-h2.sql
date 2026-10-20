-- Local Control Host store, migration h2 (ADR-0006 implementation resolution). Owned by the trusted host, like h1.
-- It separates two facts that h1 conflated: budget settlement of a permit, and active-work ownership. A permit that
-- was settled as consumed still owns the run it created until that run is observed terminal, so revocation and
-- expiry can stop it. Registration proofs are one-time: a replay can neither allocate a generation nor change one.

-- Work that an admitted permit created and that has not been observed terminal. Stop scope is derived from these rows
-- regardless of the permit's accounting state. Rows survive a host restart and stay in scope until released.
CREATE TABLE active_work (
  work_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  session_id TEXT NOT NULL,
  permit_id TEXT NOT NULL REFERENCES permits(permit_id),
  work_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run')),
  host_instance TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','released')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence_json TEXT,
  UNIQUE (permit_id, work_ref)
);
CREATE INDEX active_work_by_policy ON active_work(policy_id, state);

-- A one-time proof handed only to the process the host launched. Only its digest is stored. Consumption is atomic with
-- the runtime registration it authorizes, so a replayed proof is refused without changing the live generation.
CREATE TABLE registration_proofs (
  proof_sha256 TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  kind TEXT NOT NULL CHECK (kind IN ('launch')),
  expected_json TEXT NOT NULL,
  host_instance TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT,
  runtime_generation TEXT
);
CREATE INDEX registration_proofs_by_operation ON registration_proofs(operation_id);
