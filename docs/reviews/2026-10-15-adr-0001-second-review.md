# ADR-0001 second review

Date: 2026-10-15  
Subject: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md), as amended after the [first review](2026-10-15-adr-0001-review.md)  
Verdict: **Much closer; still not ready to accept.** ADR1-02 through ADR1-05 are addressed. The fix for ADR1-01 overcorrects: as written, the dispatch preflight blocks execution for any provider whose CLI also hosts the authoring bridge. For Codex and Antigravity that is the normal setup. The amendment also changes Cache pin semantics that M3 defines differently.

## Status of the first-review findings

| Finding | Status | Notes |
| --- | --- | --- |
| ADR1-01 bridge isolation | **Addressed, with a new defect** | The managed-invocation marker, fail-closed preflight, Inherit handling, copied Map directories and user-only setup guidance are all specified. The preflight rule conflicts with the setup guidance; see ADR2-01 |
| ADR1-02 untrusted output and execution | Addressed, one gap | Authoring-only default, `--allow-execution`, and an untrusted data envelope with provenance. The opt-in sits where the authoring agent can change it; see ADR2-03 |
| ADR1-03 receipt boundary | Addressed in text and code | `idempotent()` in [engine.mjs](../../runtime/core/engine.mjs) now runs lookup, handler and receipt insertion in one `store.transaction` and calls `after` only for a new command after commit. No test pins this; see ADR2-04 |
| ADR1-04 v2 save retirement | Addressed, one conflict | Complete writer inventory, rerun-before-cutover ordering, system workflow excluded. The new Cache-pin rule contradicts M3; see ADR2-02 |
| ADR1-05 workspace creation | Addressed | Deliberate boundary, `workspace_required` diagnostic and an acceptance scenario. Schema placement is noted in ADR2-05 |
| ADR1-06 smaller gaps | **Still open** | Event retention, `storeId` duplication on a copied store, and the Node executable used by client configuration are not covered. The `expectedEtag` field is stated as required, which settles that item |

## New findings

### ADR2-01 (high): the preflight blocks execution for the setup the ADR recommends

The ADR now directs users to register the bridge "only in a user's local client configuration". It also says the dispatch preflight checks "user/global and workspace MCP configuration files" and fails closed when it finds the bridge or cannot tell whether the effective configuration loads it, and that "Restricted flags alone are not considered proof of isolation". For each provider, that means:

- **Codex:** the only user-level location is `~/.codex/config.toml`, the same file Codex execution reads. The preflight finds the entry and refuses every Codex Agent node and Map role. A user authoring in Codex can no longer execute with Codex.
- **Antigravity:** the only user-level location is the global `~/.gemini/config/mcp_config.json`, which every Antigravity invocation loads. The same lockout applies, and the workspace-scoped alternative is now forbidden by the setup guidance.
- **Claude Code:** user and local scopes both live in `~/.claude.json`. Local scope is keyed by project path and does not load in Deszo work directories, and Restricted runs use `--strict-mcp-config`. A preflight that only looks for the entry point in that file still refuses. Only a preflight that parses scope and the effective flags passes, and the ADR forbids relying on those flags.

D19 needs all three clients to author workflows that use all three providers, so a rule that disables a provider for its own authoring users defeats the requirement. It also gives users a reason to switch the protection off.

Recommendation: make the marker the primary boundary and base the preflight on the *effective, neutralized* configuration rather than mere presence:

1. An entry is acceptable when a **verified neutralizer** covers that CLI version. Possible neutralizers, each needing Stage 5 verification before it can be relied on:
   - the bridge's marker refusal, once marker propagation to stdio MCP children has been verified;
   - Claude's `--strict-mcp-config` with no `--mcp-config`;
   - a per-invocation server override, if Codex's `-c mcp_servers.<name>.enabled=false` is verified.

   Record which neutralizer applied on the invocation.
2. Fail closed only when the entry would load and no verified neutralizer exists for that CLI version. Keep a version-pinned compatibility table, so a CLI update that breaks propagation is detected rather than assumed.
3. If Antigravity provides no verified neutralizer, allow a workspace-scoped registration in a dedicated authoring directory. The preflight must verify that the directory lies outside every Deszo workspace root and copied work directory. Travelling configuration is a problem only when the project scope sits inside a workspace that Deszo copies.

### ADR2-02 (medium): the new Cache-pin rule contradicts the M3 contract

The ADR says a revision that changes a Cache node or its producer "leaves the pin marked stale and unusable until explicitly repinned". [M3 Cache semantics](../M3_M4_CONTRACTS.md) define the opposite: when the fingerprint changes, `GET …/cache-pins` reports `sourceChanged: true` and "nothing is unfrozen or replaced automatically". The pin keeps working, and that is the purpose of a Frozen checkpoint: editing an expensive producer must not force it to rerun. The ADR's rule would turn routine authoring edits into checkpoint invalidations, and it changes existing behavior through an ADR about authoring.

Recommendation: state that pins stay governed by M3. A workflow revision does not change pin usability, and `sourceChanged` reports the drift. Keep only the genuinely new rule: a pin whose Cache node was removed is retained as an orphan and never applied to a later node with the same ID. That rule needs a contract entry and a fixture, because today's lookup is by workflow and node ID.

### ADR2-03 (medium): `--allow-execution` lives where the authoring agent can rewrite it

The opt-in is a flag in the client's MCP configuration (`~/.codex/config.toml`, `~/.claude.json`, `~/.gemini/config/mcp_config.json`). An authoring session with file-write tools, which is the usual configuration for these CLIs, can add the flag itself once prompted by untrusted content. The registration becomes execution-enabled the next time the client starts. That makes the flag a sensible default but not a boundary. The only control outside the model's reach is the in-app confirmation, which the ADR leaves optional.

Recommendation: keep `--allow-execution`, but make the runtime the authority. Either make in-app confirmation of externally requested runs the default (on unless the user disables it in Deszo settings), or have the runtime record which registrations may execute in its own settings, changed only through the Deszo window. Bridge registrations need a stable identity for the latter; a client-supplied label is only a claim, as the ADR already notes.

### ADR2-04 (low): the receipt-boundary change has no regression test

The helper change is in the code and the ADR's Context section now describes it as current behavior, but no test in `runtime/tests` refers to receipts. Add a fixture that makes the receipt write fail after the handler's writes, for example by forcing `putJson` to throw for the receipt payload. Assert that the run row, journal events and receipt are all absent and that no dispatch happened. Without it, a later refactor could move the insert outside the transaction again unnoticed.

### ADR2-05 (low): `workspace_required` is a new problem code on a v2 endpoint

`start_run` maps to the existing v2 `POST /api/v2/runs`. Its problem-code enumeration in [runtime-api-v2.schema.json](../schemas/runtime-api-v2.schema.json) does not include `workspace_required`. Stage 1 should either add it as an additive v2 change, with the editor and other v2 callers tolerating it, or return it only through a v3 run-creation path. Today the ADR does not say which.

## Recommended path

Fix ADR2-01 and ADR2-02 in the ADR text, choose an authority for ADR2-03, and close the three ADR1-06 items. ADR2-04 is a test to add now, independent of acceptance. After that the ADR is ready for the user's acceptance decision.
