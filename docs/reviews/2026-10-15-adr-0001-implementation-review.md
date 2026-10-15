# ADR-0001 implementation review

Date: 2026-10-15  
Subject: the ADR-0001 implementation recorded in the [implementation status](../adr/0001-implementation-status.md)  
Verdict: **The core runtime and bridge flow works, but the change is not shippable yet.** The desktop app and the frontend do not compile, and one test fails. The managed-invocation refusal can be bypassed, and the dispatch preflight required by the ADR is missing. The status record also misstates what exists.

## What was verified

The implementer reported that no tests or builds had been run. The following were run for this review; none uses a provider or subscription quota.

| Check | Result |
| --- | --- |
| `npm test` | **349 / 350 pass.** 1 failure: `loops.test.mjs:348` expects migration version 5; the store is now at 6 |
| `npm run docs:check` | Pass |
| `npm run build` (tsc + Vite) | **Fails:** `src/transport.ts(45,129)` TS2345, the conditional-header union is not assignable to `Record<string, string>` |
| `cargo check --locked` | **Fails:** `cannot find macro __cmd__get_runner_connection` ([main.rs:413](../../src-tauri/src/main.rs)) |
| `npm run runtime:bundle` | Pass. `dist-runtime/` contains `runner.mjs`, `bridge.mjs` and `m6.sql` |
| Packaged runner with `--dev-test-confirmation-off` | Rejected: "The packaged runtime was given an unsupported option" |
| Bundled bridge | Loads and rejects unknown options |
| End-to-end harness (isolated runtime + source bridge over stdio, scratchpad only) | See below |

End-to-end harness results:

- `initialize` negotiates `2025-06-18`.
- **Authoring-only by default:** a default registration lists 16 tools with no `start_run`/`stop_run`; `--allow-execution` adds both.
- **Conditional saves:** create with `expectedEtag: null` succeeds. Replaying the same `requestId` returns the original ETag. A second create returns `412 precondition_failed` with the current ETag. A `workflow_changes` event is recorded.
- **External scope:** `PUT /settings`, `PUT /workspaces/…`, the pending queue and `…/decision` all return `403`. The first-party token reaches the queue (`200`).
- **Confirmation on:** an external `start_run` returns `outcome: "confirmation_pending"` and creates no run, and `get_run_request` reports `pending`. First-party approval returns `202` with `approved` and a run ID.
- **Managed marker:** a marker equal to this runtime's instance ID is refused with `managed_invocation_denied`. **A marker from any other instance is served** (ADR1-I03).

Also confirmed by reading the code:

- The receipt boundary is atomic.
- A failed approval leaves no partial run, because `captureRun` throws before its transaction.
- Request expiry runs at startup and before status, list and decision calls.
- `initialize()` backfills Cache incarnations and attaches existing pins, so pins survive the upgrade.
- The editor uses the first-party token when present and hides approvals without it.
- `get_runner_connection` gates on the bundled origin and path.

## Findings

### ADR1-I01 (high): the desktop app does not compile

In [main.rs](../../src-tauri/src/main.rs), `#[tauri::command]` is attached to `bundled_frontend_loaded` (line 261), not to `get_runner_connection` (line 277). That function is still listed in `generate_handler!` (line 413), so `cargo check` fails, and neither the packaged app nor `tauri dev` can be built.

Fix: move the attribute onto `get_runner_connection`. `bundled_frontend_loaded` takes `&AppHandle` and is an internal helper, not a command.

### ADR1-I02 (high): the frontend build fails

In `saveWorkflow` ([transport.ts:44-45](../../src/transport.ts)), `const conditional = expectedEtag === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag }` infers a union with optional `undefined` members, which `request(…, extraHeaders: Record<string, string>)` rejects. `npm run build`, and therefore `desktop:build`, fails.

Fix: annotate it as `const conditional: Record<string, string> = …`.

### ADR1-I03 (medium, security): the bridge serves a managed invocation from another runtime instance

[bridge.mjs:96](../../mcp/bridge.mjs) refuses only when `DESZO_MANAGED_INVOCATION === descriptor.runtimeInstanceId`. The ADR says the bridge refuses "when it is present". The harness confirmed that a different non-empty marker is served. Two realistic cases:

- A Codex or Claude agent managed by a development runtime (repository `.deszo`) loads a user-level bridge registration that points at the installed app's connection file.
- A provider process outlives a runtime restart.

In both cases the managed agent gets full authoring tools, and execution tools as well if the registration enables them, against a store it should never manage.

Fix: refuse whenever the marker is present and non-empty, and report the mismatch in the refusal for diagnosis. Add a test for both the same-instance and other-instance cases.

### ADR1-I04 (medium): the dispatch preflight is not implemented

The ADR requires a second boundary before each managed dispatch:

- resolve the CLI version, configuration scopes and launch flags;
- detect a Deszo bridge entry that would load;
- permit it only under a verified, version-pinned neutralizer;
- fail closed with a typed diagnostic otherwise;
- record the isolation mechanism.

The engine sets only the marker and records `managedToolIsolation: { mechanism: 'bridge-marker-refusal' }` ([engine.mjs:1729-1734](../../runtime/core/engine.mjs)). Nothing reads [mcp-neutralizers.json](../authoring/mcp-neutralizers.json), and no configuration resolution exists. With every registry entry `unverified`, the ADR's rule means any managed invocation whose configuration would load the bridge must currently fail closed; today it proceeds. The status record lists neutralizers only as Stage 5 verification and does not list the preflight as unimplemented.

### ADR1-I05 (medium): `tauri dev` permanently disables confirmation in the development store

In debug, when the window is not on the bundled origin (that is, under `tauri dev`), the supervisor adds `--dev-test-confirmation-off` (main.rs:345). The runner then **persists** a new settings revision with `externalRunConfirmation: false` and creates a workspace `main` (runner.mjs:67-74). The store used is the debug storage root, the repository `.deszo`, which is also the default root of `npm run runner`.

This departs from the ADR in two ways:

- The policy is not startup-only. It survives later launches, including a standalone runner or a `tauri build --debug` app against that store.
- It does not run in an isolated fixture runtime, as the ADR requires; it runs against the developer's ordinary store.

Fix: hold the policy in memory for the process lifetime, overriding the saved setting without writing it. In debug, either launch against a separate fixture root or document that the dev store is a fixture store. Do not auto-create a workspace in a store you don't own.

### ADR1-I06 (low): authoring stream catch-up drops events beyond 200

`streamAuthoring` ([runner.mjs:223-224](../../runtime/runner.mjs)) sends one `workflowChanges({ after, limit: 200 })` page and ignores `nextCursor`. It then moves `after` to the 200th event, and live events continue from there. An editor reconnecting with more than 200 events outstanding silently skips the rest, which breaks the ADR's "event reconnection neither loses changes" scenario. Loop until `nextCursor` is null, or send `resync` when the backlog exceeds one page.

### ADR1-I07 (low): the remaining divergences from the ADR

- **Confirmation-off requests have no record.** An external request handled under confirmation-off creates no `external_run_requests` row, so `get_run_request` returns `404` for it. The ADR expects the status query to report the outcome consistently. Record the request as `approved` with its run ID in the same transaction.
- **`stop_run` annotation.** It is annotated `destructiveHint: false`. Stop cancels in-progress Full Access work and should be `true`, so hosts prompt appropriately.
- **Provenance lookup cost.** `artifactProvenance` scans and parses every attempt envelope in the store on each `read_artifact` call. That is O(store) per call; acceptable now, but it needs an index before large stores.

### ADR1-I08 (low): the test suite and the status record

- **The stale assertion.** Update `loops.test.mjs:348` to 6. Add migration-6 assertions: the `runtime_identity` row, `revision = 1` for existing workflows, and pin-to-incarnation backfill including orphans.
- **No tests for the new behavior.** Only `helpers.mjs` and `pipeline.test.mjs` were migrated. The ADR's Stage 4 list needs tests: the scope table, approval and denial paths, expiry across restart, v3 precondition races and replays, Cache incarnation removal and re-add, Antigravity path checks, stream reconnect, and both marker cases. The harness above shows these are straightforward to write against an isolated runtime.
- **The status record is inaccurate.** The [implementation status](../adr/0001-implementation-status.md) says the receipt-write rollback fixture "was not added", but it exists (`engine.test.mjs:74`) and passes. It also says no tests or builds were run, and the results above supersede that. Neither the dispatch preflight (ADR1-I04) nor the compile failures are recorded.

## Recommended order

1. Fix ADR1-I01 and ADR1-I02, then update the stale assertion (ADR1-I08), so build and test are green.
2. Fix the marker check (ADR1-I03) and make the dev policy non-persistent (ADR1-I05), each with a test.
3. Implement the dispatch preflight against the neutralizer registry (ADR1-I04). Until it exists, keep the status record explicit that the ADR's isolation boundary is incomplete.
4. Add the Stage 4 integration tests, fix ADR1-I06 and ADR1-I07, and correct the status record.

Gated items correctly left for later, per the ADR's staging: the real-provider pilot rerun, confirmation-on by default, the v2 save `410` cutover, and live client verification.
