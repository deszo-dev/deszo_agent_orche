# External workflow authoring

Version: 2.0
Status: Runtime API v4 Draft/Publication lifecycle; v3 writes retired
Updated: 2026-10-24

## Current Draft and Publication API (2026-10-24)

The supported lifecycle is **Draft → Validate → Publish → Run**. Draft and Publication APIs are public Owner Token operations. Publication is explicit, validates the exact Draft ETag, and returns an immutable version. Owner Token access does not require a second Publication approval. A Host-bound Run still needs its exact Host permit.

1. Discover Drafts and latest Published Versions with `GET /api/v4/workflows`.
2. Create/read a Draft at `/api/v4/workflows/{id}/draft`. Create with `If-None-Match: *`; update with the exact strong ETag in `If-Match`. The body is `{ "requestId": "<uuid>", "workflow": <complete workflow> }`.
3. Validate that exact revision with `POST /api/v4/workflows/{id}/draft/validate`, body `{}`, and `If-Match: <draft-etag>`.
4. Publish with `POST /api/v4/workflows/{id}/publish`, body `{ "requestId": "<uuid>" }`, and the same `If-Match`. A successful response is the immutable Published Version.
5. Read versions from `/api/v4/workflows/{id}/versions`, `/versions/{number}`, or `/versions/latest`. Use `POST /api/v4/workflows/{id}/draft/from/{number}` to edit from a Published Version.
6. Start a Run with the exact `publishedVersionId`, `definitionDigest`, and `snapshotSha256` returned by that Published Version, plus `workflowId`, `workspaceId`, and a stable `requestId`.

Draft save permits semantic diagnostics so invalid work can be corrected. Publication requires successful structure and semantic validation. The full `definitionDigest` includes persisted `view` layout; `executionHash` omits presentation-only layout. Each Run records the exact immutable Published Version and its digest. Editing or publishing a later version does not change an admitted Run. Existing legacy `kind='user'` workflows are imported as version 1 without rewriting historical Run rows; invalid legacy versions stay readable but cannot run.

The owner authorized implementation Option A on 2026-10-24. This implementation record does not itself mark the surrounding P33/P34 proposals Accepted; see the [ADR-0001 cutover record](../adr/0001-external-workflow-authoring-api-and-mcp.md#amd-19-and-p34-implementation-cutover-2026-10-24).

## Runtime and client migration

The Runtime uses a persisted Owner Token for public HTTP/MCP operations and a separate per-Runtime Host credential for internal Host routes. Owner Token possession proves bearer possession, not a human decision. The retired `PUT /api/v3/workflows/{id}` route replays only an identical previously committed receipt; new saves return `410 api_upgrade_required`, and changed requests that reuse a committed request ID return `409 conflict`. Startup durably denies pending external Run requests with a typed `policy_cutover` problem while preserving their original receipts. The UI and MCP writer use the v4 lifecycle.

Deszo exposes workflow authoring through API v3 and a shared local stdio MCP bridge. The bridge attaches to an already running Deszo runtime. It does not launch a runtime or read the database. Other local tools can call the same authenticated loopback HTTP API directly.

For current controller operations use the [Deszo Control skill](../../skills/deszo-control/SKILL.md) and the maintained `scripts/deszo-control.mjs` preflight/preparation commands. The [2026-10-21 control review](../reviews/2026-10-21-deszo-control-review.md) explains profile compatibility, complete supervised MCP tooling, reusable transport evidence and build receipts. A successful build alone is insufficient to select a runtime for an existing profile.

The separate [Antigravity Judge Stage 1 scope](JUDGE_STAGE1.md) adds opt-in, invocation-scoped evidence and Worker-only decision submission. Its production-component tests do not certify installed native Judge delivery or extend the older client acceptance below; see the [qualified report](../reviews/2026-10-21-antigravity-stage1-report.md).

The [acceptance test plan](ACCEPTANCE_TEST_PLAN.md) defines the ordered release gates. The [2026-10-15 acceptance report](../pilots/2026-10-15-authoring-acceptance.md) records the native probes, successful real-provider rerun, confirmation-default change, v2 save cutover, and installed-client results.

## Generate a client configuration

1. Start Deszo and open **Settings → External authoring bridge**.
2. Select Codex, Claude Code or Antigravity. Keep **Expose start and stop run tools** unchecked for authoring-only access.
3. For Antigravity, choose a dedicated authoring directory and its MCP config file. Both paths must be absolute, exist, and stay outside every registered workspace.
4. Select **Generate client config**, then copy the result into the selected client's MCP server configuration. Use the client's user-level configuration for Codex and Claude Code; do not add the server to a project configuration that may be copied into managed work directories.
5. Restart or reload the client. The bridge starts when the client connects and reads the selected runtime's `connection.json` descriptor.

Deszo generates an absolute Node executable, bridge-script path and connection-file path. It never puts the bearer token into the copied configuration. The connection file contains the Runtime Owner Token; protect it with normal local account permissions.

The generated shapes are:

```toml
[mcp_servers.deszo]
command = "<absolute-node-path>"
args = ["<absolute-bridge-path>", "--connection-file", "<absolute-connection-path>", "--client-provider", "codex"]
```

```json
{
  "mcpServers": {
    "deszo": {
      "command": "<absolute-node-path>",
      "args": ["<absolute-bridge-path>", "--connection-file", "<absolute-connection-path>", "--client-provider", "claude"]
    }
  }
}
```

Use the configuration generated by Deszo for the real paths and selected provider. For Antigravity, the arguments also include `--working-directory` and `--mcp-config-path`; its handshake verifies the paths against registered workspaces. Client config locations and commands vary by client release; consult the official [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude Code MCP guide](https://code.claude.com/docs/en/mcp), and [Antigravity MCP guide](https://antigravity.google/docs/mcp).

## Available tools and trust boundaries

The `managed-task` template and `task` node are published through the same v3 discovery/validation/save API. `get_managed_task` reads its captured plan, current phase, aggregate work and delivery operation; `get_run_processes` includes its Git/check children. Execution-enabled bridges also expose `stop_node`. These additions do not grant external recovery or approval rights. See [managed tasks](../MANAGED_TASKS.md) for configuration, source snapshot and boundary requirements.

The default registration exposes contract/schema/template discovery, provider capabilities, workflow and workspace reads, Draft CRUD, validation, Publication, Published Version reads, legacy conditional-save receipt replay, workflow-change pages, run-request status, bounded run-event pages, run snapshots and bounded artifact reads. Run evidence and artifact bodies are marked as untrusted data with source provenance. The Result Viewer renders values as text and does not interpret output as HTML.

The optional **Expose start and stop run tools** setting adds `start_run` and `stop_run`. `start_run` requires an exact Runnable Published Version and an explicitly selected workspace. It cannot create a workspace. Owner Token Run admission is direct even when the legacy `externalRunConfirmation` setting is enabled; Host-bound runtimes additionally require a genuine Host permit. `--allow-execution` only controls MCP tool exposure and grants no API privilege.

The bridge refuses tool calls whenever `DESZO_MANAGED_INVOCATION` is present, including markers from a different or previous runtime instance. Before each managed provider dispatch, Deszo checks the provider's user and project MCP configuration for a Deszo bridge entry, meaning any `bridge.mjs` launched with `--connection-file` from any install location. The dedicated Antigravity authoring configuration is not checked, because its directory lies outside every workspace. The check consults the version-pinned [neutralizer registry](mcp-neutralizers.json). A detected entry blocks the attempt until the exact CLI version and configuration scope have a verified mechanism.

The [2026-10-15 native probes](../pilots/evidence/2026-10-15-authoring-compatibility.json) verify Windows user/project registrations for Codex `0.162.0-alpha.17.2`, Claude Code `2.1.292`, and Antigravity `1.3.5`. Claude and Antigravity propagate the managed marker to MCP children. Codex Inherit requires explicit child markers through exec-level configuration overrides; its Restricted profile omits the observed user/project configurations. Deszo prepares those arguments automatically for the exact verified version. Untested versions/scopes and Codex server names requiring quoted dotted overrides remain blocked. The final bundled bridge was re-probed; all three installed authoring clients and the real reference pilot also passed. The pilot included one explicit controller retry; see [ADR-0001 status](../adr/0001-implementation-status.md).

## Direct HTTP clients

Read the authoring contract at `GET /api/v3/authoring/contract`, then fetch the workflow schema and node catalogue. Validate a working candidate through `POST /api/v3/workflows/validate` or validate the saved Draft revision through `/api/v4/workflows/{id}/draft/validate`. Use the Draft/Publication sequence above for all new content.

The Owner Token authorizes public Runtime API operations through HTTP or MCP, including settings, workspaces, supervision, triage and recovery. It proves possession of a bearer credential, not a human action. Host-bound Run admission still requires a genuine Host permit; the Owner Token cannot authenticate Host-origin operations. The prior external-token restrictions described in the 2026-10-15 guide are historical and do not describe the current working tree.

Both v2 and v3 workflow-save routes return `410 api_upgrade_required` for new or changed writes. Exact replay of an identical previously committed v3 receipt remains available through the retired route and MCP `put_workflow`; the MCP tool does not translate old writes into Drafts. The [migration note](MIGRATION_V3.md) records the cutover. An open bridge reconnects to the same store after an app restart; a changed store or application root requires a new explicit client connection.
