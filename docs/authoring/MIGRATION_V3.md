# Workflow authoring migration

Date: 2026-10-15

Authenticated `PUT /api/v2/workflows/{workflowId}` now returns HTTP 410 with code `api_upgrade_required`. This applies to both unconditional and formerly guarded v2 saves. The request does not change a workflow, revision, authoring event, or save receipt. Other v2 routes, including workflow reads, validation, runs, run requests, events, artifacts, and Cache pins, keep their existing scope rules.

Use `PUT /api/v3/workflows/{workflowId}` with a complete workflow and a stable UUID `requestId`:

- For creation, send `If-None-Match: *` and `expectedEtag: null`.
- For an update, first read the v3 workflow and send its exact ETag in both `If-Match` and `expectedEtag`.
- Retry an uncertain save with the identical request ID, precondition, and content. Its durable receipt returns the original result. Reusing the ID with different content is a conflict.
- A stale precondition returns HTTP 412. Keep the local draft, read the newer revision, and reconcile it before making a new save command.

The shared MCP bridge and Deszo editor already use this protocol. There is no unconditional user-workflow save fallback. Internal Context chat snapshots use a separate reserved system-workflow path.

Fresh stores and older settings documents without `externalRunConfirmation` now require approval of external run requests in Deszo. An explicitly persisted `false` remains false across an upgrade: existing storage cannot distinguish an earlier default from an intentional opt-out. Inspect the setting in Deszo when upgrading an existing installation.

HTTP clients must inspect the result of `POST /api/v2/runs` before accessing a run ID. With confirmation enabled, the response has `outcome: "confirmation_pending"`, a request ID, and a status path; it creates no run until approval. With confirmation explicitly disabled, a successful request has `outcome: "created"` and a `run` object. Repeating an original pending command returns its original receipt even after approval; use the status path to read the current decision and run ID.

The bridge's default tool set remains authoring-only. Explicit `--allow-execution` exposes start/stop requests, without approval authority. An already open bridge can reconnect after an app restart by rereading the connection descriptor and authenticating the same store and application root. A descriptor pointing to another store is refused. No credentials are embedded in generated client configuration.

See the [setup guide](README.md), [acceptance plan](ACCEPTANCE_TEST_PLAN.md), and [implementation evidence](../adr/0001-implementation-status.md).
