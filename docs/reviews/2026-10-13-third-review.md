# Third Review: Verification of the v0.7 Resolution

Reviewed: 2026-10-13
Subject: [2026-10-13-second-review-resolution.md](2026-10-13-second-review-resolution.md) and every file it changed (the M1 contracts, 5 schemas, DDL, map example, LOOPS/PIPELINE/MAP/HISTORY/STORAGE, and the new `tools/` and `fixtures/`).
Previous: [second review](2026-10-13-second-review.md)

**Verdict: the resolution is accurate.** All 13 findings from the second review are fixed in their normative homes, not only in the resolution table. I reran the new validation command, and its output matches the reported counts exactly. One new defect remains for M1: the `waiting_for_user` run state can no longer be reached (§2.1). The other notes are implementation hints. Once §2.1 is settled, the M1 package can be implemented, pending the user's explicit authorization.

---

## 1. Verification of each claim

| Finding | Claimed fix | Verified evidence |
| --- | --- | --- |
| M1-1 failure kills siblings | `draining` state | M1_CONTRACTS transition table and failure paragraph; `draining` appears in the run enum in the DDL, API, and journal schemas, and in the one-active-run index. `fixtures/decisions.json#failurePolicy` covers first failure, a later failure, drain completion, and Stop during draining. |
| M1-2 per-workflow capacity | Application settings | The workflow `settings` now accepts only `nativeConfiguration`. There is a new `application-settings.schema.json`, an `application_settings` singleton table with a revision, `PUT /settings` with `expectedRevision`, and a `run.capacity_changed` event. The negative case `workflow-capacity-forbidden` exists, and capacity fixtures cover cross-workspace and lowered-below-occupancy cases. |
| M1-3 write amplification | Batching + inline envelopes | RUN_HISTORY §Log batching (64 KiB / 250 ms, terminal flush, 1 MiB backpressure, raw bytes kept). STORAGE §36/§64 and `journal_events.envelope_json`, which has a size CHECK tied to its byte length. |
| M1-4 no list APIs | Paginated lists | Endpoints for runs, workflows, and workspaces with `listQuery`/`runListQuery`. The cursor rules (fence, seek, 400/404 cases) are specified. The DDL has matching `(created_at DESC, id DESC)` indexes. |
| M1-5 binding scoping | `run_context_bindings` | Mapping table keyed by `(run_id, context_node_id)` with `mode`. A partial unique index enforces one `new` origin per binding. `bindingId` is a UUID in every schema. `runSnapshot.contexts` is exposed. |
| M1-6 small gaps | Each one addressed | Two named hashes: `createRun.workflowSnapshotSha256` pins `snapshotSha256`. The Rust-owned Job is specified, including what happens in standalone mode. Every planned node gets a scheduled attempt (fixture `nullable-planned-attempt`). The model pattern now allows `[]`. The semantic list includes unique slot IDs and unique provider records. The timeout maximum is an integer capability, with only a minimum in the schema. |
| 3.1 zero-active join | Decision table | PIPELINE_EXECUTION §Route has a 5-row outcome table. The fixtures include `all-inactive`, `accepted-delivery`, and `successful-verify-evidence`. |
| 3.2 test-case inputs | CHECK-* inputs + rule | Both test tasks now list `spec:CHECK-AUTH` and `spec:CHECK-RESUME` in their inputs **and** readScopes. The oracle (`map_issues`) requires each check whose arguments name an output path in *both* the inputs and the scopes. Negative cases exist for both tasks. |
| 3.3 unbounded repair | Map-level counter | IMPLEMENTATION_MAP §Verification-cycle bound sets 3 per generation; the count survives retargeting, and an operational failure does not count. Five fixtures cover these cases. |
| 3.4 utility embeds Agent | `embeddedRoles` | PIPELINE_EXECUTION §Role views and registry. `fixtures/roles.json` exists, and `role.candidate`/`role.review` are checked. |
| P1 reproducibility | `npm run docs:check` | Runs offline and returned `errors: []`. Counts: 10 schemas, 57/25/14 cases, 230 links, 23 files, 21 decision cases, 24 SQL cases, 13 tables — identical to the resolution note. Before running the script I read it: no network calls, no pip installs, no file writes, and the only subprocess is the Python interpreter. |
| P2 authorization | Unchanged | Correct. Only the user can authorize implementation. |

## 2. Remaining findings

### 2.1 `waiting_for_user` is now unreachable in M1 (fix before M1)

The only M1 trigger for `waiting_for_user` is "Required Context needs explicit review". Here is every way M1 can produce a binding in `needs_review`:

- **A failed attempt.** That attempt's failure already moves the run to `draining`, then `failed`.
- **A canceled attempt.** M1 has only root Stop, which moves the run to `canceled`.
- **An interrupted attempt.** A restart moves the run to `interrupted`.
- **A Continue binding that is already in `needs_review` when the run is created.** This is rejected, because Continue requires an existing *ready* binding.

So no M1 path enters `waiting_for_user`. The documents never say which wins when one failure produces both a run failure and a Context review, and the state still holds the workspace's single active-run slot. An implementer will either write dead code or invent a trigger.

**Change:** Pick one of these:
- (a) Remove `waiting_for_user` from M1 transitions and keep the enum value reserved for M2's scoped recovery.
- (b) Define the trigger exactly, for example "a dispatch-time binding check finds `needs_review`", and add the precedence rule: failure → `draining` wins, and the binding's `needs_review` status is recorded on the failed run.

Either way, add a fixture for it.

### 2.2 Implementation hints (no doc change required, but useful)

- **Suspended launch from Rust.** `std::process::Command` gives no handle to the primary thread, so "launch Node suspended, assign it to the Job, then resume it" needs `CreateProcessW` with `CREATE_SUSPENDED` called through the `windows` crate (or `NtResumeProcess`).
- **Draining the Job safely.** "Close the Job and wait for descendants" works best as `TerminateJobObject`, then poll `JobObjectBasicAccountingInformation.ActiveProcesses == 0`, then `CloseHandle`. Once the handle is closed, the job can no longer be queried.
- **Backpressure vs. timeout.** Pausing reads from the stdout pipe can stall a CLI while its timeout keeps counting "active process time". A slow disk would then look like a provider `timeout`. Record stalls caused by backpressure, and classify an expiry that occurs during a stall as a `capture` or `corruption` error, not a provider timeout.
- **Two toolchains for docs.** `docs:check` needs Python 3.11 plus `jsonschema` in a Node project. That is acceptable as a reference oracle. The M1 validator in Node must consume the same fixtures anyway, as tools/README says, and at that point the Python dependency could be retired or kept only as a second opinion.

## 3. Result

| Area | Status |
| --- | --- |
| Previous findings (13) | All resolved and verified in their normative homes |
| Validation reproducible | Yes: `npm.cmd run docs:check`, offline, passes |
| New M1 defect | 1 (§2.1, `waiting_for_user` reachability) |
| M2–M6 | Prerequisites still listed in MILESTONES, as intended |
| Ready to implement M1 | After §2.1 is decided, subject to the user's explicit authorization |
