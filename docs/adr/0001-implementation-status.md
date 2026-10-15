# ADR-0001 implementation status

Date: 2026-10-15  
Decision: [ADR-0001](0001-external-workflow-authoring-api-and-mcp.md)  
Status: implemented and release-verified for the listed Windows CLI versions and configuration scopes

The accepted authoring architecture is implemented across the contract, runtime, editor, shared bridge, and storage. All six release gates passed for the supported configurations on 2026-10-15. Read the [acceptance report](../pilots/2026-10-15-authoring-acceptance.md) and its [machine-readable evidence](../pilots/evidence/2026-10-15-authoring-acceptance.json) for package hashes, client calls, request/run identities, crash recovery, and limitations.

The [acceptance test plan](../authoring/ACCEPTANCE_TEST_PLAN.md) was executed in order: exact-version native isolation proofs preceded the real-provider pilot; the successful pilot preceded the confirmation-default change and the v2 save cutover. Installed-client checks exercised the resulting package. The reference pilot required one explicit controller retry and is reported as `passed_with_controller_recovery`.

| ADR stage | Delivered behavior | Verification |
| --- | --- | --- |
| 1. Contract package | V3 authoring schemas, scopes, save receipts, durable change events, limits, and migrations 6/7. | Conditional saves, rollback, retries, and provenance regressions pass. The old internal snapshot method accepts only the reserved system chat workflow. |
| 2. Runtime and editor | Scoped credentials, approval queue, lossless event catch-up, draft preservation, Cache incarnations, and Antigravity path checks. | Fresh/missing-field confirmation defaults are true; persisted false is preserved. V2 saves return 410 without mutation. Native concurrent clients produced one save and one 412. Clean/dirty editor behavior passed in the installed UI. |
| 3. Shared bridge and packaging | One stdio bridge attaches to an existing runtime. Execution is opt-in; every managed marker is refused. Reconnect authenticates the same store/root and retains request identity. | All three native clients used UI-generated config and the installed bridge. An open bridge reconnected across runtime/app crashes. The packaged fixture-policy option was rejected. |
| 4. Fixture and integration verification | Authorization, approval/denial/expiry, concurrency, migration, reconnect, bounds, and process containment regressions. | 373 Node tests, four native Windows tests, frontend build, runtime bundle, and documentation checks pass. |
| 5. Client and provider verification | Exact-version neutralizers and setup guidance; real reference pipeline and installed-client campaign. | Codex, Claude Code, and Antigravity each created, edited, requested approval-gated execution, and read run/events/artifacts from a new session. Three mixed-provider runs succeeded; both installed-app crash cases passed. |

## Verified support boundary

| Client | Exact version | Verified Windows configuration | Managed-run mechanism |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.162.0-alpha.17.2` | User and project; New/Continue; Restricted and Inherit | Restricted omits observed MCP configuration. Inherit adds an explicit child marker for each simple server name after `exec`. |
| Claude Code | `2.1.292 (Claude Code)` | User and project; New/Continue | Marker propagation to MCP children, which return `managed_invocation_denied`. |
| Antigravity | `1.3.5` | Global and project; New/Continue; dedicated authoring directory | Marker propagation, plus authenticated directory/workspace collision checks. |

See the [registry](../authoring/mcp-neutralizers.json) and [native compatibility evidence](../pilots/evidence/2026-10-15-authoring-compatibility.json). Unknown versions, uncovered scopes, and Codex names requiring quoted dotted overrides remain blocked when a Deszo entry is detected. Claude local/managed-system and non-Windows configurations are not live-verified.

## Local validation

| Check | Result |
| --- | --- |
| `npm test` | Pass: 373 tests; no fixture model calls. |
| `npm run build` | Pass (TypeScript and Vite). |
| `cargo check --locked` (from `src-tauri`) | Pass. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | Pass: four native tests, including Job Object descendant containment. |
| `npm run runtime:bundle` | Pass. |
| `npm run docs:check` | Pass. |
| Real-provider smoke | Pass with explicit `gpt-6-luna` and `haiku`; fresh isolated root. |
| Reference pilot | Pass with one explicit controller recovery; 20 provider calls, 26 exported tests and 21 independent checks. |
| Installed clients | Pass: three authoring clients, nine mixed-run provider calls, two controlled-crash provider calls. |

Deterministic tests use fixtures. Native compatibility, smoke, pilot, and installed-client checks used real subscription calls under the user's authorization; no provider/model or API-billing fallback was used. The installed acceptance package has its own application identifier and data root. The standard installer is built from the same source and matching runtime/frontend assets, without installing over the existing user store. See the [migration note](../authoring/MIGRATION_V3.md) before upgrading a client or an existing confirmation preference.
