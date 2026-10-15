# ADR-0001 implementation follow-up review

Date: 2026-10-15  
Subject: fixes for the [implementation review](2026-10-15-adr-0001-implementation-review.md), as recorded in the [implementation status](../adr/0001-implementation-status.md)  
Verdict: **All eight implementation-review findings are fixed and verified.** One new medium finding: the Antigravity pre-dispatch check treats the registered authoring configuration as if it loads in managed runs. That blocks Antigravity execution whenever an Antigravity authoring bridge is connected, which defeats the ADR's Antigravity fallback.

## Verification

All checks were rerun independently. None invokes a provider or uses subscription quota.

| Check | Result |
| --- | --- |
| `npm test` | 364 / 364 pass, including the new `runtime/tests/authoring.test.mjs` (14 tests) and the corrected migration assertion |
| `npm run build` | Pass |
| `cargo check --locked` | Pass |
| `cargo test --locked` | 4 / 4 pass (not listed in the status record) |
| `npm run runtime:bundle` | Pass |
| `npm run docs:check` | Pass |
| End-to-end stdio harness (isolated runtime and bridge, rerun unchanged) | All earlier results reproduce. A **foreign managed marker is now refused** with `managed_invocation_denied`; it was served before the fix |

## Status of implementation-review findings

| Finding | Status |
| --- | --- |
| ADR1-I01 Tauri compile | Fixed; `cargo check` and `cargo test` pass |
| ADR1-I02 frontend build | Fixed; `npm run build` passes |
| ADR1-I03 foreign marker served | Fixed. [managed-invocation.mjs](../../mcp/managed-invocation.mjs) refuses any non-empty marker and says whether it matched; covered by a test and the harness |
| ADR1-I04 dispatch preflight | Implemented. [managed-isolation.mjs](../../runtime/core/managed-isolation.mjs) scans each provider's configuration scopes and requires an exact verified neutralizer per CLI version. It fails closed as `managed_tool_isolation_unavailable` before the CLI starts, and the mechanism is recorded in the invocation manifest. With the registry unverified, any detected entry blocks the run, as the ADR requires. See ADR1-F01 and ADR1-F02 |
| ADR1-I05 dev confirmation | Fixed. The override is in memory only (`externalRunConfirmationOverride`). `tauri dev` uses `.deszo/tauri-dev-fixture`, and the runner refuses the policy on the default `.deszo` root |
| ADR1-I06 stream catch-up | Fixed. The stream pages until `nextCursor` is null, with a test beyond 200 events |
| ADR1-I07 smaller divergences | Fixed. Confirmation-off requests record an `approved` row. `stop_run` is marked destructive. Provenance uses the migration-7 reverse index |
| ADR1-I08 tests and status | Fixed. The Stage 4 coverage listed in the status exists, and the status record is now accurate |

## New findings

### ADR1-F01 (medium): the registered Antigravity authoring config blocks every managed Antigravity run

For Antigravity dispatch, the engine passes the MCP config paths of recently seen Antigravity bridge registrations as `additionalConfigPaths` ([engine.mjs:1736-1743](../../runtime/core/engine.mjs)). `scanAntigravity` scans those paths as if they load in the managed invocation. A registered authoring config contains the bridge entry by definition, so while an Antigravity authoring bridge is connected, every managed Antigravity invocation fails with `managed_tool_isolation_unavailable`. Once the bridge's 90-second heartbeat lapses, runs succeed again.

This contradicts the ADR's Antigravity fallback. The dedicated authoring directory is acceptable precisely because it lies outside every workspace root and copied Map directory, which the handshake and workspace checks already enforce, so Antigravity does not load it in a managed run. The behavior is also inconsistent: the same run passes or fails depending on whether the authoring session is open.

The test `Antigravity managed preflight scans project and registered workspace MCP paths` asserts the scan but never covers the intended configuration: a registered authoring config outside the managed `cwd`, with no project entry.

Fix: drop `additionalConfigPaths` from the load-detection scan. Scan only the global config and the `.agents/mcp_config.json` files in the managed `cwd` ancestors, which are the ones that can load. If a defensive check is wanted, assert that the managed `cwd` is not inside a registered authoring directory, which the path checks already guarantee. Add a test that a registered authoring config outside `cwd` yields `bridge-marker-refusal` with no entries.

### ADR1-F02 (low): detection matches only this runtime's own bridge path

`serverIsBridge` compares configured commands and arguments with `this.bridgeScript`, the bridge path of the runtime doing the dispatch. A registration that points to a different Deszo bridge goes undetected:

- the installed app's bundled `runtime/bridge.mjs`, seen from a development runtime;
- the development `mcp/bridge.mjs`, seen from the installed app;
- a bridge from an older install location.

The bridge-side marker refusal (ADR1-I03, now fixed) still blocks those tools, so this is not an open bypass. But the preflight's recorded `bridge-marker-refusal` with `bridgeEntries: []` would then be inaccurate evidence, and the ADR describes the preflight as the boundary for CLIs without verified marker propagation.

Fix: match any Deszo bridge entry point, for example by the bundle's file name plus a content signature, or by a known-locations list (bundled resource path, repository path, development path). Alternatively, record in the ADR that the preflight covers only the dispatching runtime's own bridge.

## Recommendation

Fix ADR1-F01 before any live Antigravity client verification; otherwise the Stage 5 Antigravity check cannot pass with the documented setup. ADR1-F02 can follow. Remaining release gates are unchanged and correctly recorded:

- verified, version-pinned neutralizers;
- the authorized real-provider pilot rerun;
- confirmation on by default;
- the v2 save 410 cutover;
- live verification with all three clients.
