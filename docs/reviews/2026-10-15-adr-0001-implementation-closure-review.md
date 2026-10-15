# ADR-0001 implementation closure review

Date: 2026-10-15  
Subject: fixes for the [implementation follow-up review](2026-10-15-adr-0001-implementation-followup-review.md)  
Verdict: **Both findings are fixed and independently verified. No open implementation findings remain.** ADR-0001 is ready for the staged Stage 5 release gates.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 366 / 366 pass, exit 0 |
| `npm run docs:check` | Pass |
| Bundled runtime | Contains the new matcher (`dist-runtime/runner.mjs`) |
| Matcher probe (public `inspectManagedToolIsolation`, isolated home, scratchpad only) | See ADR1-F02 below |

Frontend and Rust code are unchanged since the follow-up review, where `npm run build`, `cargo check --locked` and `cargo test --locked` passed.

## ADR1-F01: fixed

`scanAntigravity` ([managed-isolation.mjs](../../runtime/core/managed-isolation.mjs)) now scans only the global `~/.gemini/config/mcp_config.json` and the `.agents/mcp_config.json` files in the managed `cwd` ancestors, which are the configurations a managed invocation can load. The engine no longer passes registered authoring paths into dispatch. `bridge_registrations` is now used only for the workspace-collision checks, which is its intended role. A new test confirms that a registered authoring config outside `cwd` yields `bridge-marker-refusal` with no entries, so the result no longer depends on whether a bridge heartbeat is recent.

## ADR1-F02: fixed

An entry now counts as a Deszo bridge if it launches a `bridge.mjs` with `--connection-file`, wherever that bridge is installed. The exact-path match for the runtime's own bridge is kept. Probe results:

| Configured entry | Result |
| --- | --- |
| Installed path containing spaces (`C:\Program Files\…\runtime\bridge.mjs`, separate args) | Detected |
| Same path inside a single quoted argument string | Detected |
| Upper-case `BRIDGE.MJS` at an older location | Detected |
| `--connection-file=…` form | Detected |
| Own bridge path without the flag | Detected (exact-path match) |
| Unrelated `bridge.mjs` without the flag | Not detected |
| Unrelated server with `--connection-file` | Not detected |
| `npm run mcp:bridge -- --connection-file …` | Not detected |
| A `.cmd` wrapper that launches the bridge | Not detected |

## Residual note (not a finding)

Wrapper launches (an npm script or a shell/cmd wrapper) cannot be recognized from the configuration alone. That is acceptable for these reasons:

- Deszo's generated client configuration always launches the absolute Node executable with the absolute bridge path, a form that is always detected.
- The bridge's own refusal of any managed marker still blocks tools in a wrapped launch.
- The setup guide already directs users to the generated configuration.

If wrapped launches are ever documented as supported, add them to the matcher or state the limitation in the [authoring guide](../authoring/README.md).

## Remaining release gates

These are unchanged and correctly recorded in the [implementation status](../adr/0001-implementation-status.md):

- verified, version-pinned neutralizers for Codex, Claude Code and Antigravity;
- the authorized real-provider pilot rerun;
- external-run confirmation on by default, after that rerun;
- the v2 save `410` cutover;
- live verification with all three clients.
