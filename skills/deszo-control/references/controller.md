# Controller procedure

The checkout's `mcp/controller-client.mjs` is the reusable caller. The application owns scheduling, process containment and workflow rules. This caller owns no authorization policy and performs no automatic ACK.

## Connection

**AMD-19/P34 cutover (2026-10-24):** The connection descriptor contains the Runtime Owner Token. It authorizes public operations and proves bearer possession, not a human decision. Internal Host routes require a separate Host credential; an Owner Token does not provide Host provenance. Use the API v4 Draft/Publication tools for new workflows. The legacy `put_workflow` tool only replays an identical committed v3 save receipt; new or changed writes return `410 api_upgrade_required` and are never mapped to Draft saves.

Use the explicit profile and `doctor --build BUILD --live` result. Pin its `selected.storeId` and `selected.bridgeScript`. Do not print the connection descriptor; it contains the Owner Token.

In one persistent `node_repl` session, with `timeout_ms: 55000`:

```javascript
var toUrl = (await import('node:url')).pathToFileURL;
var controlApi = await import(toUrl(repo + '/mcp/controller-client.mjs').href);
var control = await controlApi.connectDeszo({
  connectionFile: profile + '/runtime/connection.json',
  expectedStoreId: reviewedStoreId,
  expectedBridge: reviewedBridgePath,
  allowExecution: true,
});
var unwrap = controlApi.unwrap;
```

Use `control.call(tool, arguments)` and unwrap its MCP envelope. Inspect only the required tool schemas from `control.request('tools/list')`; do not dump the entire inventory on every turn. `control.tools` contains names. Validate the actual contract, workspace and workflow snapshot before mutation.

Do not close or replace a healthy bridge during an active run: controller credentials and observation receipts exist only in that process. After a runtime restart read the current contract again; the initial `control.contract` is historical.

## Exact run

1. Read `get_workflow` and `get_latest_published_version`. If there is no Draft, use `derive_workflow_draft` with the selected Published Version. Save edits with `put_workflow_draft` using the exact current ETag (or `expectedEtag: null` for the first Draft), validate with `validate_workflow_draft`, and publish with `publish_workflow` using that same ETag. Publication does not start a Run.
2. Read `list_workspaces` and select an existing workspace. The bridge cannot create one.
3. For supervised work, `create_controller_session` returns a public session ID while the bridge retains its credential. Request a grant with `request_control_grant`, bound to the exact snapshot of a Runnable Published Version and to the workspace (an unpublished Draft is refused with `409 conflict`), `control.clientVersion`, requested actions and business deadlines. The Owner Token can use the public grant decision endpoint; verify the final grant using `get_control_grant`.
4. Submit `start_run` with the selected Published Version's exact `publishedVersionId`, `definitionDigest` and `workflowSnapshotSha256`, plus workspace and one stable request ID. Owner-authorized public Runs return `outcome: created` directly. A Host-bound Runtime still requires a real Host permit; never replace that technical precondition with an Owner Token. Reconcile an uncertain response with the same request ID before creating another Run.
5. `start_run` returns the Run identity. For supervised runs, prepare emergency Stop after the native arm if it is not ready yet. `observe_run` returns a bounded contiguous receipt. Process it; read any required `detailId` ranges in order. Explicitly call `acknowledge_run_observation` with that `observationId`, run/session, exact cursor and a stable ACK request ID. Never process or ACK an unpresented oversized response.

Use current tool schemas for argument names. Business deadlines belong to the approved grant; a 45-second transport timeout does not change them. Reads and live bridge traffic are not semantic acknowledgement. Fetch the next receipt immediately when there is backlog; otherwise use bounded waits and leave routine Developer/Watcher decisions inside their workflow.

## Recovery and incidents

With the same bridge alive, `get_controller_state` recovers held public sessions, legacy pending requests, receipt cursors and in-flight operations. Cutover-denied legacy requests do not start. Replay a pending observation; retry an uncertain ACK with its recorded request ID. Reconcile uncertain writes with `get_command_status` and their original IDs.

A new bridge cannot take over an old grant from public IDs. Reconcile/Stop through the remaining authorized controller or operator path, verify termination and obtain fresh authority for a new run. Do not disable a watchdog or send an invented ACK to cover context loss.

For a suspected Deszo bug, use root Stop and/or `stop_and_report`; its observation must follow the published `incidentObservation` schema. Confirm `get_run_processes` and the termination outcome/proof. Preserve artifact references, hashes, the exact request IDs and the distinction between complete and truncated capture. Verify that an incident ID was registered; a spool/queue receipt is only pending delivery. If the runtime is unavailable, preserve a local incident payload without editing its database or pretending registration succeeded.

Checkpoint only public identities and evidence: profile/build paths, source fingerprint, runtime/store IDs, workflow revision/hash, workspace binding, session/grant/request/run IDs, pending observation/ACK IDs, status, actual process state and the next action. Record errors immediately; do not leave a failed launch marked ready. Never put bearer, controller, emergency or first-party credentials into a checkpoint or journal.
