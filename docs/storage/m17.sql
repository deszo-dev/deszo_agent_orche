-- Process Custody (H3). The Engine's durable workspace hold for a Host-owned process. A hold names the canonical physical root that its
-- invocation may modify. It is written with the binding, before the launch, and it is released only when the Host proves that the
-- invocation's process tree has ended. It survives Engine restarts and temporary Host unavailability, so neither an unreachable Host
-- nor a new Engine makes that workspace available while the CLI may still run in it.
CREATE TABLE custody_workspace_holds (
  custody_id TEXT PRIMARY KEY REFERENCES attempt_custody(custody_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  workspace_root TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'released')),
  evidence_json TEXT,
  held_at TEXT NOT NULL,
  released_at TEXT,
  CHECK ((state = 'released') = (released_at IS NOT NULL))
);

CREATE INDEX custody_workspace_holds_state ON custody_workspace_holds(state);
