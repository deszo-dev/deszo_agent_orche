-- Reference migration 10 (ADR-0003 follow-up audit A5): execution plan revisions are keyed by (id, plan_revision_id).
-- Applied after m9.sql. Stores that applied the earlier m9 have execution_plans keyed by id alone and cannot hold a
-- second revision of a plan; this rebuild keeps every existing row. It is also correct for a store already keyed by
-- (id, plan_revision_id), where it copies the same rows into an identically keyed table.

CREATE TABLE execution_plans_rebuilt (
  id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL REFERENCES task_assessments(id) ON DELETE CASCADE,
  execution_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  policy_version INTEGER NOT NULL,
  delivery_boundary TEXT NOT NULL CHECK (delivery_boundary IN ('candidate','verified_branch')),
  plan_fingerprint TEXT NOT NULL,
  plan_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  status TEXT NOT NULL CHECK (status IN ('draft','validated','active','superseded','completed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, plan_revision_id)
);

INSERT INTO execution_plans_rebuilt (id, plan_revision_id, assessment_id, execution_run_id, policy_version, delivery_boundary, plan_fingerprint, plan_artifact_id, status, created_at)
  SELECT id, plan_revision_id, assessment_id, execution_run_id, policy_version, delivery_boundary, plan_fingerprint, plan_artifact_id, status, created_at
  FROM execution_plans;

DROP TABLE execution_plans;
ALTER TABLE execution_plans_rebuilt RENAME TO execution_plans;
CREATE INDEX execution_plans_by_assessment ON execution_plans(assessment_id);
CREATE INDEX execution_plans_by_execution_run ON execution_plans(execution_run_id);
