-- Bind a pending externally requested run to the controller authenticated at submission.
-- Only durable identities are stored here; controller credentials remain out of the store.
CREATE TABLE run_request_controls (
  request_id TEXT PRIMARY KEY REFERENCES external_run_requests(request_id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES control_grants(id),
  controller_session_id TEXT NOT NULL REFERENCES controller_sessions(id)
);
