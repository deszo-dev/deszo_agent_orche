-- Reference migration 9 (ADR-0003, ADR-0004, ADR-0005: Task Assessment, Execution Plans, Acceptance Records, and Branch Delivery).
-- Applied after m8.sql.

-- Task assessments authored by Analyst with source-derived facts and risk axes.
CREATE TABLE task_assessments (
  id TEXT PRIMARY KEY,
  assessment_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  business_request_id TEXT NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  assessment_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX task_assessments_by_run ON task_assessments(assessment_run_id);

-- Versioned execution plans selected from assessments, linking lifecycle identities.
CREATE TABLE execution_plans (
  id TEXT PRIMARY KEY,
  plan_revision_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL REFERENCES task_assessments(id) ON DELETE CASCADE,
  execution_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  policy_version INTEGER NOT NULL,
  delivery_boundary TEXT NOT NULL CHECK (delivery_boundary IN ('candidate','verified_branch')),
  plan_fingerprint TEXT NOT NULL,
  plan_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  status TEXT NOT NULL CHECK (status IN ('draft','validated','active','superseded','completed')),
  created_at TEXT NOT NULL
);
CREATE INDEX execution_plans_by_assessment ON execution_plans(assessment_id);
CREATE INDEX execution_plans_by_execution_run ON execution_plans(execution_run_id);

-- Typed criterion-to-evidence acceptance records evaluated at candidate and branch boundaries.
CREATE TABLE acceptance_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  boundary TEXT NOT NULL CHECK (boundary IN ('candidate','verified_branch')),
  subject_id TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  overall_status TEXT NOT NULL CHECK (overall_status IN ('accepted','rejected','incomplete')),
  record_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX acceptance_records_by_run ON acceptance_records(run_id);

-- Local feature branch delivery records and verified READY_FOR_MERGE state.
CREATE TABLE branch_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  delivery_plan_id TEXT NOT NULL,
  target_branch_ref TEXT NOT NULL,
  commit_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('READY_FOR_MERGE','delivery_failed','precondition_failed','verification_failed','ref_conflict','stopped')),
  result_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX branch_deliveries_by_run ON branch_deliveries(run_id);
