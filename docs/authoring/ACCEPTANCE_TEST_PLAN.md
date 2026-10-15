# ADR-0001 Acceptance Test Plan

Date: 2026-10-15  
Status: Executed on 2026-10-15 for the listed Windows client versions/scopes; see the [acceptance report](../pilots/2026-10-15-authoring-acceptance.md)
Decision: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md)  
Delivery record: [Implementation status](../adr/0001-implementation-status.md)

## Purpose and current baseline

This plan defines the evidence needed for version-specific provider workarounds, the real-provider pilot rerun, enabling external-run confirmation by default, retiring v2 saves with HTTP 410, and installed-client acceptance with Codex, Claude Code, and Antigravity. The user subsequently authorized execution of the complete plan. Requirements below remain the test specification; the linked report records actual outcomes and limitations.

When this plan was written, the implementation status reported 364 passing local tests and passing build checks, three unverified neutralizers, confirmation off by default, and guarded v2 saves. That historical baseline established none of the live gates. The executed campaign recorded its own 366-test initial baseline, completed native verification, passed the real pilot, and only then enabled the default and cut over v2 saves. Final validation has 373 passing Node tests and four native tests.

The successful [2026-10-14 provider pilot](../pilots/2026-10-14-after-rerun04-validation.md) predates the ADR-0001 changes. It is historical evidence, not the required rerun for this integration.

## Ordered release gates

| Gate | Work | Evidence required to advance |
| --- | --- | --- |
| G0 | Freeze the candidate and validate local contracts, fixtures, and builds | Recorded source/package identities and green automated checks; production defaults and v2 cutover remain unchanged |
| G1 | Prove managed-tool isolation on exact installed CLI versions | Native positive and negative controls for each supported configuration; evidence-backed neutralizer entries or the explicitly supported Antigravity directory arrangement |
| G2 | Rerun the reference pipeline with the real providers | A new successful bounded production-adapter pilot, verified exported candidate, preserved journal, and recorded isolation mechanism for actual invocations |
| G3 | Enable confirmation by default | A separate policy change after G2; fresh-store, migration, authorization, request/decision, and packaged-runtime checks pass |
| G4 | Retire v2 workflow saves | A separate cutover after G2 and G3; all repository writers use v3 and authenticated v2 saves return 410 without mutation |
| G5 | Exercise all three real authoring clients against the installed candidate | Three recorded client passes on the final package, including authoring, approval-gated execution, lifecycle, and UI synchronization |

G1 and G2 require explicitly authorized live testing and consume subscription quota where a native model session is needed. G5 uses actual client sessions and short provider runs. G0, G3, and G4 primarily use deterministic fixtures and HTTP/UI checks that need no inference. Do not enable the production default or perform the 410 cutover merely because fixtures pass.

## G0: Candidate identity and local verification

Use isolated test roots and a Windows test profile or VM for installed-app checks. Preserve existing user stores and earlier pilot roots. Record the source revision, or hashes of relevant files when no Git revision is available, plus Node, OS, Rust/toolchain, runtime bundle, desktop executable, and bridge identities. Record each exact CLI version string as returned by the same executable Deszo discovers. Capture requested and observed models separately when available; do not substitute models if a selected one is unavailable.

Run the existing checks and retain their exit status and redacted logs:

```powershell
npm.cmd test
npm.cmd run docs:check
npm.cmd run build
npm.cmd run runtime:bundle
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

The [authoring tests](../../runtime/tests/authoring.test.mjs) and [engine tests](../../runtime/tests/engine.test.mjs) already cover several required behaviors. Keep those regressions and identify uncovered cases explicitly. Fake version strings and injected fixture registries test our matching logic; they cannot turn a real provider's registry entry into `verified`.

Add or extend harnesses before attempting the live gates. Missing harnesses are preparation work, not assumed capabilities:

- A native compatibility probe must capture a sanitized invocation, configuration scope, MCP child startup/marker evidence, typed bridge responses, and timeout/cleanup results for each candidate neutralizer.
- A bridge protocol harness must exercise the actual stdio entry point, tool visibility with and without `--allow-execution`, structured errors, reconnects, bounded results, and token redaction.
- Cutover fixtures must cover both the current guarded-v2 phase and the later retired-v2 phase. Existing run callers must check `outcome` before accessing `run.runId`.
- The evidence collector must distinguish HTTP/fixture simulations from actual authoring-client calls and production provider invocations.

## G1: Version-specific isolation and workarounds

Use three independent compatibility records. Each records provider, exact CLI executable/version, operating system, tested configuration scopes, native profile and launch arguments, chosen mechanism, raw-evidence references, and verdict. Verify the packaged bridge as well as source behavior. Do not claim support for a version range based on one installed release.

| Provider | Candidate to test; not an established workaround | Required native controls |
| --- | --- | --- |
| Codex | Marker propagation to MCP children, or per-invocation disabling of every detected Deszo server name | User and ancestor project configuration; multiple names and foreign installation paths; New/Continue; Restricted and supported Inherit profiles |
| Claude Code | Marker propagation, or `--strict-mcp-config` without an explicit MCP config that reintroduces Deszo | User, local, project, and applicable managed/system sources; New/Continue; Restricted and supported Inherit profiles |
| Antigravity | Marker propagation or a proven per-run configuration mechanism; otherwise the ADR's dedicated authoring-directory arrangement | Global and ancestor workspace configuration, dedicated authoring directory, copied Map directories, and handshake/workspace collision checks |

For every configuration scope, perform a positive control: the ordinary authoring client must load the registered server and successfully call a harmless discovery tool. A file merely existing, `--help` listing a flag, or a client saying that it ignored a server is insufficient evidence.

Then perform a managed invocation using the production invocation builder and the exact candidate profile:

1. Supply a non-empty managed-invocation marker and a real Deszo registration. Exercise a read-only management-tool attempt; use instrumentation rather than trusting an agent's prose.
2. For marker propagation, prove that the CLI-spawned MCP child receives the marker and the real bridge returns `managed_invocation_denied`. For a configuration neutralizer, prove that the same registration loads in the positive control but cannot load or provide Deszo tools under the candidate invocation.
3. Repeat across every applicable configuration source and the supported native profiles. Include renamed registrations, more than one Deszo registration, another runtime's connection file, New/Continue, and a copied Map work directory. Preserve ordinary model execution and output contracts.
4. Verify that an unknown version, missing required flag, forbidden override, or uncovered configuration source still fails closed before production dispatch. A managed marker from a previous or different runtime also remains a refusal.
5. Record an actual native model call completing under the chosen profile, with no usable Deszo management tools. An agent that happens not to call a visible tool does not establish isolation; missing MCP observations are inconclusive.

The production preflight blocks an unverified candidate. Bootstrap verification therefore needs an explicitly diagnostic probe in an isolated root/profile, using the exact production launch construction while observing the native CLI directly. Do not mark the production registry verified just to get the probe through, turn off the preflight, or use fixture adapters as native evidence. After evidence is reviewed and the exact entry is recorded, repeat the scenario through normal engine dispatch.

For Antigravity, a successful dedicated-directory test verifies only that supported setup. It does not verify suppression of a global registration. Exercise absent or conflicting path metadata, canonicalized aliases/junctions, workspace creation/movement, and copied Map paths. A global Deszo entry remains unsupported until its exact native behavior is proved; do not encode directory-only success as a verified global neutralizer.

Keep real credentials in their existing native storage. Use supported configuration isolation where possible. If a user-level registration must be exercised, snapshot and restore only the affected configuration under a test profile; do not replace accounts or copy credential files into evidence. Scope configuration changes to the test and verify restoration.

Pass G1 only for configurations with evidence. Publish the supported tuple and limitations. If a required client cannot satisfy the accepted configuration boundary, keep the gate open and address the implementation or record a design change; do not weaken the expected result to obtain a pass.

## G2: Real-provider reference pilot rerun

Run [scripts/pilot.mjs](../../scripts/pilot.mjs) in a fresh evidence root after G1. Use the production provider adapters with the selected Codex, Claude Code, and Antigravity models, normal output schemas, and bounded workflow/call limits. The script currently pins its three requested model IDs in source; record and confirm those values before launch. Neither diagnostic schema-prompt option is acceptable for a production acceptance result.

An example invocation, after selecting a new unused root, is:

```powershell
node --disable-warning=ExperimentalWarning scripts/pilot.mjs --root .deszo/pilots/adr0001-2026-10-15-01 --minutes 60
```

The pilot must run in the presence of the supported authoring registrations. Otherwise it can miss the regression where installing the authoring bridge blocks all managed execution. For Antigravity, register the dedicated authoring directory through the real handshake and keep it outside the pilot workspace. Record the isolation mechanism from actual invocation manifests, including Map roles and copied directories.

Require the complete reference path: specification review, Gate approval, implementation/test tasks, candidate assembly, real engine checks, technical approval, and final Customer acceptance. Export the accepted candidate, rerun its generated suites, and apply the independent [pilot acceptance probe](../../scripts/pilot-acceptance.mjs) to the exported project directory containing `src/api.mjs`. Audit certificate subjects, captured hashes, selected task results, check reports, journal continuity, Replay state, and absence of surviving provider processes. Use the [pilot summarizer](../../scripts/pilot-summarize.mjs) with explicit roots so earlier evidence is preserved.

The current pilot creates its own standalone runtime and uses a first-party credential. It verifies the real execution path, not the external MCP host, approval UI, or Tauri Job Object. Those are separate G3/G5 assertions. A successful first-party pilot cannot establish that an external client waits for approval.

Keep failures and all recovery actions. Quota/authentication outages do not count as successful acceptance, and provider/model substitution does not rescue the original test. A successful run with explicit recovery can be reported as such; it must not be called unattended. Map-origin revision and selective carry remain fixture evidence unless they actually occur in the rerun.

## G3: Enable external-run confirmation by default

Only after G2 passes, change the production default in a separate reviewable change. Align engine initialization, the missing-field fallback, the settings schema, and documentation. Fixtures may explicitly select confirmation off in isolated source runtimes; the packaged runtime must still reject `--dev-test-confirmation-off`.

Test the settings transition as well as the request flow:

| Case | Expected result |
| --- | --- |
| Fresh installed store | Confirmation is on without a manual settings change |
| Older settings without the new field | The documented migration/fallback produces confirmation on |
| Persisted true or false | Saved preferences follow an explicit migration contract; a stored false is not silently overwritten or described as automatically enabled |
| Authoring-only bridge | `start_run` and `stop_run` are absent |
| Execution-enabled bridge | `start_run` returns `confirmation_pending`; no run/provider dispatch occurs before approval |
| Approval in bundled Deszo window | One run and one decision receipt commit; dispatch follows commit |
| Explicit denial or 30-minute expiry | No provider dispatch; status remains durable across restart |
| Changed workflow/workspace before approval | Approval rechecks the pinned identities and returns the specified conflict/failure without dispatch |
| Repeated request or decision after lost response | No duplicate run; the original request receipt and current status retain their distinct meanings |
| External token with a forged label or Origin | Cannot approve/deny, change settings, recover a run, move a workspace, or obtain first-party authority |
| First-party setting explicitly disables confirmation | Subsequent requests may create runs; already pending requests still need a decision or expiry |

The stored boolean does not by itself distinguish an old default from a user's explicit opt-out. The implemented migration contract preserves a persisted false and makes missing fields default to true, as described in the [migration note](MIGRATION_V3.md). G5 must use a fresh store or explicitly verified confirmation-on settings rather than assuming that upgrading an existing false value changes it.

Use fixture adapters and fault injection for exhaustive authorization, expiry, stale-subject, transaction, and duplicate-request cases. Also verify the approval queue in a packaged frontend: bundled debug/release origins qualify for first-party IPC, while `tauri dev`, browser development, and navigated/remote pages do not. Capture no first-party token in screenshots or logs.

## G4: Retire v2 workflow saves with 410

After G2 and G3, inventory executable writers again. Cover the editor, bridge, [smoke script](../../scripts/smoke.mjs), pilot scripts, test helpers, direct engine callers, and source/bundled entry points. Search the code, then exercise the paths; a search alone cannot prove that dynamically constructed requests use v3.

Before cutover, assert the existing compatibility behavior: v2 saves need an idempotency key and create/update precondition and cannot bypass guarded revisions. After cutover, an authenticated `PUT /api/v2/workflows/{id}` returns `410 api_upgrade_required` for both the old body and a formerly valid guarded request. It must not modify workflow snapshots, revision, authoring sequence, or command receipts. Authentication failures remain authentication failures.

Verify that v3 create/update/read, conflict handling, idempotent retries, and editor synchronization still work. Keep v2 reads, validation, run outcomes, run-request operations, events, artifacts, and separate Cache-pin routes functioning under their assigned scopes. Retiring the workflow-save route must not retire every path containing `/workflows`.

Run the full local suite/build checks again and rebuild the final package. Exercise migrated smoke/pilot setup against the new routes. The smoke harness now defaults to a fresh root and also accepts an explicit unused root; do not delete old evidence to make a rerun pass. Record source differences from the G2 pilot baseline. Default/route changes need their focused regressions; changes to execution, provider arguments, transport, or isolation invalidate the affected live evidence and require the corresponding rerun.

Publish a migration note covering the 410 response, v3 preconditions/request IDs, and both v2 run outcomes. Do not restore an unconditional save fallback to keep an old script green.

## G5: Installed-app checks with all three authoring clients

Use the final installed package after G3/G4, in an isolated Windows profile. Generate configuration through Deszo and exercise actual Codex, Claude Code, and Antigravity sessions. A generic MCP test client or raw HTTP request is useful for fixtures but cannot stand in for these three passes. Record app, bridge, Node, CLI, model, configuration-scope, and final artifact identities.

Each client performs the same scenario:

1. Attach to the already running app using its generated configuration. Read the contract, schemas, node catalogue, and templates. Verify the selected store/root and one runtime process.
2. From an English pipeline request, create and validate a small workflow containing explicit Codex, Claude, and Antigravity nodes. Save it through MCP, inspect the returned identity/diagnostics, and open it in the Deszo canvas.
3. Edit the workflow through the client. A clean selected editor refreshes; a dirty editor keeps its edits and reports a revision conflict. Exercise two concurrent clients and a lost save response with the same request ID.
4. With an authoring-only registration, confirm run tools are absent. Reconnect using the explicit execution opt-in and request a short real run with confirmation on. The client receives `confirmation_pending`, and engine/process evidence shows zero provider dispatch before approval.
5. Approve in the bundled Deszo window. Exactly one run executes the pinned snapshot, using the supported isolation mechanisms; the client reads status, bounded events, and verified artifacts. Test denial and expiry primarily with fixtures to avoid repeated inference.
6. Close/reopen the client and reconnect from its cursor without creating another runtime or losing workflow state. Closing a client leaves Deszo and its runs alive. A controlled app-close test verifies containment and unavailable bridge errors; reopening does not automatically retry provider calls.

For Antigravity, include its real dedicated-directory handshake and the workspace collision scenario. For all clients, verify no runtime credential appears in copied configuration or MCP results. Use deterministic HTTP/protocol tests for the wider negative matrix; a natural-language agent's failure to choose a particular tool is not a passing negative test.

A compact live campaign can use three short authoring sessions, one small mixed-provider workflow per client, the native isolation probes, and one full reference pilot. Agree the model IDs, wall limits, and quota bounds before launch. The pilot's repair loops make an exact invocation count unknowable in advance. Stop at the agreed bound and report an incomplete gate rather than changing providers or silently expanding the budget.

## Evidence, verdicts, and completion

Keep raw local data under a fresh acceptance/pilot root. Publish a redacted gate report and referenced artifacts under [pilot evidence](../pilots/evidence/). Include source/package hashes, full detected version strings, supported scopes, configuration digests, native observation logs, request/run IDs, snapshot hashes, test counts, operator actions, cleanup results, and verdicts. Never publish connection files, full process environments, private startup-token lines, or credentials.

Each gate is `not_run`, `passed`, `failed`, or `blocked`, with a reason and evidence references. Inconclusive native behavior remains unverified. Recording a plan, generating a client config, or completing an old pilot changes none of those verdicts.

Update the neutralizer registry only with exact evidence-backed mechanisms. Update the implementation status with actual G0-G5 results, then the setup guide with minimum verified versions and limitations. ADR-0001 is fully release-verified only when every required client/configuration and gate has current evidence for the shipped candidate.
