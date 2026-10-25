-- Process Custody (H3). The unresolved condition of a held workspace. A definitive Host refusal about a held invocation (for example
-- `not_found`: the Host answering has no record of it) is not evidence that its process tree ended, so the hold stays held. The condition
-- records what the Host refused, so that the hold is never silently stuck; it is cleared when the Host answers for the invocation again.
ALTER TABLE custody_workspace_holds ADD COLUMN unresolved_json TEXT;
ALTER TABLE custody_workspace_holds ADD COLUMN unresolved_at TEXT;
