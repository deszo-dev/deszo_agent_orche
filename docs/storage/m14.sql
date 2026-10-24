-- ADR-0008 linked self-repair continuation and lifecycle gates. Additive only: no existing run, attempt, artifact or journal
-- row is rewritten. A link ties a suspended parent run to the repair run that the Engine created for it; a lifecycle
-- operation records a Judge proposal that the Engine accepted and the Host has not yet confirmed.
CREATE TABLE run_links (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('linked_repair')),
  parent_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  repair_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  parent_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repair_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  resume_node_instance_id TEXT NOT NULL,
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  checkpoint_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'repair_failed', 'repair_completed', 'resumed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_run_id <> repair_run_id)
);
CREATE INDEX run_links_by_state ON run_links(state);

CREATE TABLE lifecycle_operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  node_instance_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'application.activate_candidate'),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  target_version TEXT NOT NULL,
  continuation_checkpoint_id TEXT NOT NULL,
  proposal_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  installation_id TEXT,
  profile_root TEXT,
  expected_generation TEXT,
  state TEXT NOT NULL CHECK (state IN ('intent', 'verified')),
  receipt_artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'verified') = (receipt_artifact_id IS NOT NULL))
);
