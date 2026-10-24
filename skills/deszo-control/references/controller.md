# Controller procedure

The checkout's `mcp/controller-client.mjs` is the reusable caller. The application owns scheduling, process containment and workflow rules. This caller owns no authorization policy and performs no automatic ACK.

## Connection

Use the explicit profile and `doctor --build BUILD --live` result. Pin its `selected.storeId` and `selected.bridgeScript`. Do not print the connection descriptor; it contains an external credential.

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

1. Read `get_workflow` and `list_workspaces`. For an authorized task revision, validate then `put_workflow` with the live ETag and one stable request ID. Inspect the resulting diff; preserve bindings and limits.
2. `create_controller_session` returns a public session ID; the bridge retains its credential. Request supervision with `request_control_grant`, the exact workflow snapshot/workspace, `control.clientVersion`, approved actions and explicit business deadlines.
3. If approval is required, ask the user for the exact grant in Deszo. Verify with `get_control_grant`; replaying an idempotent request can return the original pending receipt.
4. Submit `start_run` with the grant ID, session ID, exact snapshot/workspace and one stable request ID. If confirmation is pending, verify that same ID with `get_run_request` or `await_run_start`. Never create a second request because a reply was lost.
5. `await_run_start` (wait <=20 seconds) returns the actual request, initial observation and emergency-preparation result. Check supervised mode and prepare emergency Stop after the native arm if it is not ready yet.
6. `observe_run` returns a bounded contiguous receipt. Process it; read any required `detailId` ranges in order. Explicitly call `acknowledge_run_observation` with that `observationId`, run/session, exact cursor and a stable ACK request ID. Never process or ACK an unpresented oversized response.

Use current tool schemas for argument names. Business deadlines belong to the approved grant; a 45-second transport timeout does not change them. Reads and live bridge traffic are not semantic acknowledgement. Fetch the next receipt immediately when there is backlog; otherwise use bounded waits and leave routine Developer/Watcher decisions inside their workflow.

## Recovery and incidents

With the same bridge alive, `get_controller_state` recovers held public sessions, pending requests, receipt cursors and in-flight operations. Replay a pending observation; retry an uncertain ACK with its recorded request ID. Reconcile uncertain writes with `get_command_status` and their original IDs.

A new bridge cannot take over an old grant from public IDs. Reconcile/Stop through the remaining authorized controller or operator path, verify termination and obtain fresh authority for a new run. Do not disable a watchdog or send an invented ACK to cover context loss.

For a suspected Deszo bug, use root Stop and/or `stop_and_report`; its observation must follow the published `incidentObservation` schema. Confirm `get_run_processes` and the termination outcome/proof. Preserve artifact references, hashes, the exact request IDs and the distinction between complete and truncated capture. Verify that an incident ID was registered; a spool/queue receipt is only pending delivery. If the runtime is unavailable, preserve a local incident payload without editing its database or pretending registration succeeded.

Checkpoint only public identities and evidence: profile/build paths, source fingerprint, runtime/store IDs, workflow revision/hash, workspace binding, session/grant/request/run IDs, pending observation/ACK IDs, status, actual process state and the next action. Record errors immediately; do not leave a failed launch marked ready. Never put bearer, controller, emergency or first-party credentials into a checkpoint or journal.
