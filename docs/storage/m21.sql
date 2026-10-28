-- P4 durable, typed questions. The immutable prompt/answer-spec/answer bytes remain ordinary artifacts.
CREATE TABLE workflow_questions (
  id TEXT PRIMARY KEY,
  root_run_id TEXT NOT NULL REFERENCES runs(id),
  originating_run_id TEXT NOT NULL REFERENCES runs(id),
  link_id TEXT REFERENCES run_links(id),
  incident_id TEXT,
  judge_attempt_id TEXT NOT NULL REFERENCES attempts(id),
  decision_id TEXT NOT NULL UNIQUE,
  published_version_id TEXT NOT NULL REFERENCES workflow_publications(id),
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
  subject_sha256 TEXT NOT NULL CHECK (length(subject_sha256) = 64),
  question_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  answer_spec_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'canceled', 'superseded')),
  answer_artifact_id TEXT REFERENCES artifacts(id),
  answer_request_id TEXT UNIQUE,
  responder_source TEXT CHECK (responder_source IS NULL OR responder_source = 'owner-token'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((link_id IS NULL) = (incident_id IS NULL)),
  CHECK ((status = 'answered') = (answer_artifact_id IS NOT NULL AND answer_request_id IS NOT NULL AND responder_source IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_workflow_question_per_root ON workflow_questions(root_run_id) WHERE status = 'pending';
CREATE INDEX workflow_questions_by_origin ON workflow_questions(originating_run_id, status, created_at);
