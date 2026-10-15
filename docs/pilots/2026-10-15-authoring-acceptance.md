# ADR-0001 authoring acceptance

Date: 2026-10-15  
Verdict: **Passed for the listed Windows client versions and configuration scopes**  
Decision: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md)  
Specification: [Acceptance test plan](../authoring/ACCEPTANCE_TEST_PLAN.md)  
Machine-readable record: [Acceptance evidence](evidence/2026-10-15-authoring-acceptance.json)

The user authorized the complete acceptance campaign, including real subscription calls and an isolated installed-app test. All six gates completed. Workflow authoring attaches to an already running Deszo instance through the shared MCP bridge or API v3. Confirmation defaults to on, and the v2 workflow-save route returns `410 api_upgrade_required`.

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| G0: candidate and local checks | Passed | Initial baseline: 366 Node tests. Final candidate: 373 Node tests, four native Windows tests, frontend build, runtime bundle, and documentation checks. SHA256 source manifests replace a Git revision because this checkout has no Git metadata. |
| G1: exact-version isolation | Passed within the support table below | Actual native positive controls and managed New/Continue attempts, with two differently named user/project registrations per provider. The final bundled bridge was re-probed after its reconnect change. [Compatibility record](evidence/2026-10-15-authoring-compatibility.json). |
| G2: real-provider reference pilot | Passed with explicit controller recovery | Run `55bbb7de-6652-47eb-a696-c0e99136fa45`: 20 production-provider invocations, technical approval, final Customer acceptance, verified export, 26 generated tests and 21 independent checks. [Pilot record](evidence/2026-10-15-authoring-pilot.json). |
| G3: confirmation default | Passed after G2 | Fresh stores and settings missing the field require confirmation; persisted true/false survives restart. Actual installed-window approvals dispatched the pinned snapshots. The packaged runner rejected the development confirmation-off option. |
| G4: v2 save retirement | Passed after G3 | Both legacy and formerly guarded v2 saves return 410 without a workflow/revision/event/receipt mutation. V3 writers, v2 reads/validation, run operations, and separate Cache-pin routes continue to pass. The real smoke chain also succeeded after cutover. |
| G5: installed authoring clients | Passed | Each of Codex, Claude Code, and Antigravity created, validated, saved, edited, requested a run, and read its evidence through the installed MCP bridge. Three mixed-provider runs and both crash cases passed. |

## Verified client configurations

| Client | Exact native version | Tested scope/profile | Working isolation mechanism |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.162.0-alpha.17.2` | Windows user and project; New and Continue; Inherit and Restricted | Inherit requires an explicit `DESZO_MANAGED_INVOCATION` override for each detected simple MCP server name, placed after `exec`. Restricted's `--ignore-user-config` omits the observed user/project MCP transports; no env-only server override is added there. |
| Claude Code | `2.1.292 (Claude Code)` | Windows user and project; New and Continue | The native client propagates the marker to MCP children. The real bridge returns `managed_invocation_denied`. |
| Antigravity | `1.3.5` | Windows global and project; New and Continue; dedicated authoring directory | The marker reaches MCP children, which refuse calls. The authenticated authoring-directory handshake also rejects workspace overlaps in both directions. |

The final bundle's ordinary sessions successfully called discovery tools. Managed sessions produced observable bridge refusals, or, for Codex Restricted, zero MCP starts/calls despite positive controls loading both registrations. These verdicts use actual protocol traces, rather than the models' descriptions of tool availability. A pre-existing zero-byte Antigravity global MCP configuration was initialized to valid `{}` JSON; its empty backup and repair record are retained privately. No credentials or permanent server entries were added by that repair.

The failed candidates are preserved in the private evidence root. In particular, inherited environment alone did not reach Codex MCP children; attempted root-level disable overrides did not prove isolation. Adding a marker override to an omitted Codex transport also caused a configuration error. The registry contains only the working exact-version mechanisms. Untested versions/scopes and Codex names requiring quoted dotted overrides fail closed when a Deszo registration is detected. Claude local/managed-system registrations and non-Windows environments are not live-verified.

## Reference pilot and release ordering

The accepted pilot completed in 549.052 seconds with 1,388 contiguous journal events: 11 Codex, six Claude Code, and three Antigravity invocations. Every invocation used the production adapter, subscription-only policy, and the recorded verified isolation mechanism while authoring registrations were present. No diagnostic output-schema substitution or fixture provider was used.

One task attempted to write outside its declared output file set. The runtime rejected it. After the run drained, the test controller issued one explicit retry with Context acknowledgement; the rejected attempt remains in the journal. The verdict is `passed_with_controller_recovery`, not unattended success. An earlier canceled pilot with the Codex transport-configuration error also remains preserved.

Final acceptance certificate: `CERT-5866E749D822`. Delivery subject:

```text
d6f4de3277dd604f266db65dcd20535e3dc501c4d1da00a85c10ecf7053ce3c4
```

All 14 exported subject entries match their immutable artifact bytes and recorded digests. The exported project passes 26 generated tests and the independent 21-check business acceptance probe. The journal, certificate subjects, store integrity, and owned process cleanup were audited before enabling default confirmation or retiring v2 saves.

Post-pilot changes are recorded in the acceptance JSON: confirmation initialization/fallback and the internal reserved-save guard changed in the engine; v2 retirement changed the HTTP router; the bridge gained a separate same-store reconnect transport. Scheduling, provider invocation construction, and isolation preparation remain identical to the successful pilot. The changed bridge was covered by real bundled-client probes, stdio restart/store-substitution tests, and installed crash checks. The final real Codex → Claude → Codex Context smoke also passed.

## Installed-client results

The installed candidate uses application identifier `local.deszo.acceptance20261015` and a separate data root. Client configurations were generated in **Settings → External authoring bridge**, retained without credentials, and checked against the native test registrations. A diagnostic stdio wrapper recorded protocol metadata around the actual installed bridge without changing its tool behavior. User-level temporary keys were removed individually after each test; unrelated configuration and accounts were preserved.

| Authoring client | Saved workflow | Approved real run | Result |
| --- | --- | --- | --- |
| Codex | `adr0001-codex-live` | `21334df7-7e0a-429c-bbb1-d25fda0711b3` | Succeeded; 69 contiguous events |
| Claude Code | `adr0001-claude-live` | `d597ae51-e067-4654-b6ac-a233345e561d` | Succeeded; 61 contiguous events |
| Antigravity | `adr0001-antigravity-live` | `509399e4-8c6d-4ed9-b23a-02dab7711942` | Succeeded; 66 contiguous events |

Every workflow contains a Text node, stateless Codex → Claude Code → Antigravity Agents, and a Result Viewer. Requested execution models were `gpt-6-luna`, `haiku`, and `gemini-3.8-flash-low`; observed Claude and Antigravity identities are recorded separately. Codex did not provide an observed model ID in the parsed native evidence, so that field remains null. The first Agent returned the requested literal marker; subsequent Agents received the prior answer as their complete prompt. Their final text is non-empty and digest-verified, without an invented deterministic downstream response requirement.

Authoring-only registrations exposed no start/stop tools. Explicit execution opt-in returned `confirmation_pending`. Before the first approval there were three pending requests and **zero runs** in the installed store. Five first-party decisions in the bundled window approved the three mixed-provider workflows and two disposable containment probes. Each mixed workflow created exactly one run and made exactly three real provider calls. Closing the authoring clients left Deszo and its requests/runs alive.

New native client sessions read saved workflows, durable authoring changes, run state, bounded event pages, and bounded artifacts through MCP. Run evidence was marked untrusted; returned artifact digests matched independently verified bytes. No new runtime or duplicate run was created by those reads.

The UI campaign also verified:

- A clean selected canvas automatically refreshed after an external save.
- A dirty editor retained `LOCAL_UNSAVED_DRAFT`, announced the newer revision, and rejected a stale Save without overwriting it. **Save draft as new** preserved it in a separate workflow.
- Simultaneous native Codex and Claude saves against the same ETag produced exactly one new revision and one HTTP 412; the losing client did not replace the precondition or silently retry.
- The installed window refused workspace creation over a connected Antigravity authoring directory. A bridge handshake from inside an existing workspace was also refused. The preliminary directory-only artifact is not the completed UI verdict; the final directory proof includes the recorded window refusal.

## Installed process containment and reconnection

Each controlled crash began with a real Codex invocation executing a prepared disposable Node program and its child. The controller recorded PID, executable path, and start time before terminating only its own runtime or app.

| Case | Run | Verified recovery |
| --- | --- | --- |
| Runtime killed while CLI/descendants were alive | `64b7c450-e991-4b79-a7e0-bde01de08be5` | Supervisor drained the Job Object; the frontend reconnected in 18.005 seconds. The open bridge authenticated the replacement runtime in the same store. Run became interrupted and Context needed review. |
| App killed while CLI/descendants were alive | `a5fefbfb-f594-4687-8380-9ba2f6666d37` | Runtime, CLI, and both descendants were gone. Reopening recovered the same store, preserved interrupted history and Context review, and reconnected the already open bridge. |

An offline audit found exactly one provider attempt per interrupted run, no automatic retries, zero active runs, and `PRAGMA integrity_check = ok`. The stdio tests separately prove unavailable-runtime errors, original save receipts after restart, and refusal when the selected descriptor is replaced by another store.

## Artifacts and migration

The [acceptance JSON](evidence/2026-10-15-authoring-acceptance.json) records SHA256 identities for the tested installer, installed executable, runner/bridge bundles, final source manifest, and standard release installer. The standard `local.deszo.app` installer was built from the same source and matching runtime/frontend assets. It was **not installed over the existing user store**; installed live acceptance used the separate identifier above.

Raw logs, native MCP observations, receipts, pilot roots, generated configurations, and UI text snapshots remain under `.deszo/acceptance/adr0001-20261015-01`. Public evidence omits credentials and full environments. The public connection descriptor contains no first-party token, and temporary native profile registrations are removed. The user interrupted one UI attempt with Escape; that attempt did not close a gate and the remaining UI checks were completed after explicit resumption.

Use the [setup guide](../authoring/README.md) to connect a client. Follow the [migration note](../authoring/MIGRATION_V3.md) for stable request IDs, ETag preconditions, v2's 410 response, both run outcomes, and confirmation settings. Existing persisted `false` remains false; fresh stores and missing fields now default to true.
