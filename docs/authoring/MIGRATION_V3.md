# Workflow authoring migration

Migration from the retired workflow writer to Runtime API v4 Draft/Publication.

## Current status

The v4 Draft/Publication API is the supported workflow writer. The bundled UI and MCP bridge now use it. Existing v3 writes remain retired: `PUT /api/v3/workflows/{workflowId}` returns `410 api_upgrade_required` for new writes, replays an identical previously committed request ID, and returns `409 conflict` when that ID is reused with different content. The old MCP `put_workflow` tool remains only for this exact receipt compatibility; it never translates into a Draft save.

## Current client migration

Use `PUT /api/v4/workflows/{workflowId}/draft` with the complete definition. Create with `If-None-Match: *`; update with the current ETag in `If-Match`. Save returns a Draft revision and ETag. Validate the exact revision with `POST /api/v4/workflows/{workflowId}/draft/validate`, body `{}`, and the same `If-Match`. Publish with `POST /api/v4/workflows/{workflowId}/publish`, body `{ "requestId": "<uuid>" }`, and that exact ETag. The Publish request is idempotent across Engine restarts. Read a specific immutable version at `/api/v4/workflows/{workflowId}/versions/{version}` or the latest at `/versions/latest`. To edit a Published Version, derive a Draft through `POST /api/v4/workflows/{workflowId}/draft/from/{version}` with a creation or update precondition.

New Runs must include the selected Published Version's `publishedVersionId`, full `definitionDigest`, and `snapshotSha256`. Drafts and invalid migrated versions cannot be launched. Each new Run captures the exact definition and version identity at admission. Owner Token authorizes the public API directly; the legacy `externalRunConfirmation` setting does not add an Owner approval step. Host-bound Runs still require a genuine Host permit.

At startup, every existing ordinary `kind='user'` workflow is imported as an immutable Published Version 1, including its `view`. Migration preserves invalid definitions with `runnable: false`, captures the legacy `designated-judge/1` policy identifier, and does not create a fake Publication event. `kind='system'` workflows are excluded. Historical Run IDs, snapshots, settings artifacts, events, timestamps and links remain unchanged, with no fabricated Published Version reference.

Pending legacy external Run requests are durably denied at cutover with `policy_cutover`, without dispatch. Their original pending command receipts remain replayable; current status reads report the terminal denial. A new Run requires a new Owner-authorized request.

The Owner selected Option A for implementation on 2026-10-24. That authorizes this code and client migration without changing the formal status of every Proposed amendment in ADR-0001. See the [implementation record](../adr/0001-external-workflow-authoring-api-and-mcp.md#amd-19-and-p34-implementation-cutover-2026-10-24).

## Historical pre-retirement behavior (2026-10-15)

The Runtime now uses an Owner Token for public operations and a separate per-Runtime Host credential for internal Host routes. Owner Token possession proves bearer possession, not human approval. Pending external Run requests are durably denied at owner-policy cutover with a typed `policy_cutover` problem while their original command receipts remain replayable.

## Historical pre-retirement behavior (2026-10-15)

At that time, authenticated `PUT /api/v2/workflows/{workflowId}` returned HTTP 410 with code `api_upgrade_required`. This applied to both unconditional and formerly guarded v2 saves. The request did not change a workflow, revision, authoring event, or save receipt.

Use `PUT /api/v3/workflows/{workflowId}` with a complete workflow and a stable UUID `requestId`:

- For creation, send `If-None-Match: *` and `expectedEtag: null`.
- For an update, first read the v3 workflow and send its exact ETag in both `If-Match` and `expectedEtag`.
- Retry an uncertain save with the identical request ID, precondition, and content. Its durable receipt returns the original result. Reusing the ID with different content is a conflict.
- A stale precondition returns HTTP 412. Keep the local draft, read the newer revision, and reconcile it before making a new save command.

The shared MCP bridge and Deszo editor already use this protocol. There is no unconditional user-workflow save fallback. Internal Context chat snapshots use a separate reserved system-workflow path.

The `externalRunConfirmation` setting is retained for settings compatibility only. It does not gate Owner Token Run admission and cannot create a pending request. *Superseded requirement (2026-10-15 cutover text): fresh stores and older settings documents without `externalRunConfirmation` required approval of external run requests in Deszo. AMD-19 (2026-10-24) retired that approval queue; an authorized Owner Token request is admitted directly, subject to the normal Engine checks.* An explicitly persisted `false` still reads as `false` across an upgrade, because existing storage cannot distinguish an earlier default from an intentional opt-out. That value no longer affects admission.

HTTP clients must inspect the result of `POST /api/v2/runs` before accessing a run ID. An authorized Owner Token request that passes the Published Version, digest and Engine checks returns `outcome: "created"` with a `run` object in the same response. Repeating the original command returns its original receipt. *Superseded requirement (2026-10-15 cutover text): with confirmation enabled, the response had `outcome: "confirmation_pending"`, a request ID and a status path, and created no run until a first-party approval. AMD-19 removed that path for Owner Token admission. Receipts committed before the cutover still replay their original `confirmation_pending` response. The run-request decision route returns `410 operation_retired`, and pre-cutover pending requests were denied with `policy_cutover` without launch.*

The bridge's default tool set remains authoring-only. Explicit `--allow-execution` exposes start/stop requests, without approval authority. An already open bridge can reconnect after an app restart by rereading the connection descriptor and authenticating the same store and application root. A descriptor pointing to another store is refused. No credentials are embedded in generated client configuration.

See the [setup guide](README.md), [acceptance plan](ACCEPTANCE_TEST_PLAN.md), and [implementation evidence](../adr/0001-implementation-status.md).
