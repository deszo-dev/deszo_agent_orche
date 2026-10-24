-- P34 Draft and immutable Publication cutover. Historical Run rows remain unbound to a publication.
CREATE TABLE workflow_publications (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  snapshot_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  definition_digest TEXT NOT NULL CHECK (length(definition_digest) = 64),
  execution_hash TEXT NOT NULL CHECK (length(execution_hash) = 64),
  authority_policy_version TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('legacy-migration', 'owner-publication')),
  runnable INTEGER NOT NULL CHECK (runnable IN (0, 1)),
  validation_json TEXT NOT NULL,
  source_draft_revision INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, version)
);
CREATE INDEX workflow_publications_by_workflow ON workflow_publications(workflow_id, version DESC);
CREATE TRIGGER workflow_publications_no_update BEFORE UPDATE ON workflow_publications
BEGIN SELECT RAISE(ABORT, 'published workflow versions are immutable'); END;
CREATE TRIGGER workflow_publications_no_delete BEFORE DELETE ON workflow_publications
BEGIN SELECT RAISE(ABORT, 'published workflow versions are immutable'); END;

CREATE TABLE workflow_drafts (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  source_published_version_id TEXT REFERENCES workflow_publications(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Startup performs the one-time semantic assessment and copies each legacy user definition atomically.
-- Keeping this marker separate makes retries safe if the process stops before the import transaction commits.
CREATE TABLE workflow_publication_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  legacy_import_complete INTEGER NOT NULL CHECK (legacy_import_complete IN (0, 1))
);
INSERT INTO workflow_publication_state(singleton, legacy_import_complete) VALUES (1, 0);

ALTER TABLE runs ADD COLUMN published_version_id TEXT REFERENCES workflow_publications(id);
ALTER TABLE runs ADD COLUMN definition_digest TEXT;
CREATE TRIGGER runs_published_binding_insert BEFORE INSERT ON runs
WHEN (NEW.published_version_id IS NULL) <> (NEW.definition_digest IS NULL)
  OR (NEW.kind = 'workflow' AND EXISTS (SELECT 1 FROM workflows WHERE id = NEW.workflow_id AND kind = 'user') AND NEW.published_version_id IS NULL)
  OR (NEW.published_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workflow_publications p WHERE p.id = NEW.published_version_id
      AND p.workflow_id = NEW.workflow_id AND p.definition_digest = NEW.definition_digest
      AND p.snapshot_artifact_id = NEW.workflow_snapshot_artifact_id
  ))
BEGIN SELECT RAISE(ABORT, 'workflow Run must bind an exact Published version and digest'); END;
CREATE TRIGGER runs_published_binding_update BEFORE UPDATE OF workflow_id, published_version_id, definition_digest, workflow_snapshot_artifact_id ON runs
WHEN NEW.workflow_id IS NOT OLD.workflow_id
  OR NEW.published_version_id IS NOT OLD.published_version_id
  OR NEW.definition_digest IS NOT OLD.definition_digest
  OR NEW.workflow_snapshot_artifact_id IS NOT OLD.workflow_snapshot_artifact_id
BEGIN SELECT RAISE(ABORT, 'Run Published version binding is immutable'); END;
