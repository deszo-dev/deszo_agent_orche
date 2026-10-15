# ADR-0001 third review

Date: 2026-10-15  
Subject: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md), as amended after the [second review](2026-10-15-adr-0001-second-review.md)  
Verdict: **One structural gap remains before acceptance.** Every finding from the first two reviews is now addressed. The new run-confirmation design depends on telling the Deszo window apart from every other caller. The runtime cannot do that today: the editor, the bridge and any local process all hold the same bearer token, and that token is published in `connection.json`. Until the ADR adds a first-party credential, its confirmation guarantees hold only for callers that choose to go through MCP.

## Status of earlier findings

| Finding | Status |
| --- | --- |
| ADR2-01 preflight lockout | Resolved. The bridge-side marker is the primary boundary. Configured entries are blocked only when they would load with no verified, version-pinned neutralizer. The Codex/Claude setup is paired with neutralizers, and a dedicated Antigravity directory is the fallback |
| ADR2-02 Cache pins vs M3 | Resolved. M3 semantics are kept (`sourceChanged`, no automatic invalidation), and only the orphan case is new, through Cache-node incarnations |
| ADR2-03 `--allow-execution` rewritable | Design resolved: the flag controls visibility only, and runs need in-app confirmation by default. The design is not yet enforceable; see ADR3-01 |
| ADR2-04 receipt test | Scheduled as a Stage 4 fixture. It guards code that has already shipped, so adding it now is still advisable |
| ADR2-05 `workspace_required` placement | Resolved as an additive v2 change. The companion `confirmation_pending` response is not truly additive; see ADR3-02 |
| ADR1-06 smaller gaps | Resolved: indefinite event retention, `(storeId, applicationRoot)` identity, and an absolute Node executable published by the supervisor |

## New findings

### ADR3-01 (high): "first-party" and "in-app approval" have no credential behind them

These statements depend on the runtime knowing that a request came from the Deszo window:

- "The normal Run control in the Deszo window remains a first-party user action."
- "Approval is available only through a supervisor-owned in-app path."
- "A user may turn off external-run confirmation only through the Deszo window setting."

Today there is a single credential. The runner writes `{ port, token }` to `connection.json` and prints the same object to stdout. The supervisor hands it to the webview (`get_runner_connection` in [main.rs](../../src-tauri/src/main.rs)), and the editor sends it as `Authorization: Bearer` ([transport.ts](../../src/transport.ts)). A request from the editor, from the bridge, or from any process that reads the connection file looks identical. In practice:

- A prompt-injected authoring agent with shell access, as Codex and Claude Code normally have, can skip MCP entirely. It reads `connection.json` and calls `POST /api/v2/runs` as a "first-party" caller, or calls the approve endpoint itself.
- The same agent can disable confirmation through `PUT /api/v2/settings`, which accepts the file token today.
- The release scenario "an agent that edits its client configuration … still cannot bypass this confirmation" is true only for the specific route it names.

The ADR correctly keeps "local account permissions remain the access boundary" for Full Access processes in general. But the confirmation feature exists precisely to stop a misled local agent, so it needs a credential that agent cannot read.

Recommendation: split the credential, and make it part of the Stage 1 contract.

- **First-party token:** the runner already prints its connection to the supervisor on stdout. Add a second token that appears only in that stdout line and in the supervisor's memory, and is never written to `connection.json` or to disk. Only the webview receives it, through the Tauri IPC command it already uses.
- **Scopes:** the connection-file token becomes the *external* scope: authoring, reads, run *requests* (always pending when confirmation is on) and Stop. The first-party scope adds direct run creation, approve/deny, and changing the confirmation setting. The existing settings endpoint must refuse that field under the external scope.
- **Dev and isolated setups:** state how the browser-only `web-isolated` configuration obtains the first-party scope, or that it runs with the external scope only.
- **Residual risk:** a same-account process can still read another process's memory or drive the GUI. Say that this is the residual risk, consistent with the existing storage trust note, rather than claiming an absolute guarantee.

### ADR3-02 (medium): `confirmation_pending` reuses status 202 with a different body

The table says an external `POST /api/v2/runs` returns "a durable `202 confirmation_pending` response". The existing success response is also `202`, with `{ run: { runId, … }, requestId }`. Current callers take `created.run.runId` straight from a 202: [pilot.mjs](../../scripts/pilot.mjs), [smoke.mjs](../../scripts/smoke.mjs) and the test helper [helpers.mjs](../../runtime/tests/helpers.mjs). Once ADR3-01 classifies the connection-file token as external, these callers receive the pending shape and fail on `undefined`. Among them is the pending real-provider rerun that the ADR orders *before* the v2 save cutover. A different body under the same status is a breaking change, not an additive one.

Recommendation:

- Give the pending result a distinguishable status (for example, `202` with a required discriminator such as `outcome: "created" | "confirmation_pending"`, added to both shapes), and update every listed caller in the same release.
- Decide whether repository scripts and tests run under the first-party scope or under an explicit "confirmation disabled" fixture setting.
- State that the confirmation default takes effect only after the pending pilot rerun, mirroring the ordering already given for the v2 save retirement.

### ADR3-03 (medium): approval semantics are undefined

A pending request can sit for a while before the user acts, and the ADR does not say what approval re-checks or how it commits:

- **What approval re-checks:** the saved snapshot can change between request and approval. The workspace can be deleted, or a provider can become unavailable. Approval should re-run the `createRun` checks against the request's pinned `workflowSnapshotSha256`. If the workflow moved on, the request is denied with `409`, never upgraded to the new snapshot.
- **One commit:** run creation, the request's transition to `approved`, and its run ID should commit in one transaction. Dispatch follows only after commit, matching the shared command boundary.
- **Replays:** a retried `start_run` with the same request ID replays its receipt, which still says pending. State that this is intended and that `get_run_request` is the only source of the current outcome.
- **Expiry:** the period is unspecified, and so is whether expiry survives a runtime restart. The status endpoint and the Stage 1 schema need both.
- **Notification:** the user needs to see pending requests. Specify how the window surfaces them, such as a queue with workflow, workspace, requesting label (a claim) and snapshot hash, and what happens to requests that are still pending when Deszo closes.

### ADR3-04 (low): where Cache-node incarnations live

Clients submit workflows as full replacements, so an incarnation cannot be trusted if it travels in workflow JSON. Clients would have to preserve it, and they could copy or forge it. State that the runtime assigns incarnations in its own table, keyed by workflow and node ID. They are derived when a save commits: a node present in the previous revision keeps its incarnation, and a node absent from it receives a new one. Existing pins migrate to the incarnation of their node in the current revision. Note that this derivation is per revision, so remove-then-re-add within a single replacement is indistinguishable from an edit and keeps the incarnation.

### ADR3-05 (low): how the runtime learns the Antigravity authoring directory

The runtime is to verify "that directory is outside every Deszo workspace root and copied Map work directory", but the ADR does not say how it learns the directory. Specify the signal, for example: the bridge reports its working directory and the resolved workspace-scoped config path in the handshake, and the runtime refuses the handshake when that path lies inside a workspace root. Repeat the check when a workspace is created or moved later, because a new workspace can come to contain an existing authoring directory.

## Recommended path

Add the first-party credential split (ADR3-01) and the response discriminator (ADR3-02) to the ADR, and specify approval semantics (ADR3-03). ADR3-04 and ADR3-05 can be settled in the Stage 1 contract text. With those in place, I see no further architectural blocker to the user's acceptance decision.
