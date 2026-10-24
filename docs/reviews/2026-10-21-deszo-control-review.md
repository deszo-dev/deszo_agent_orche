# Deszo operation and controller review

Date: 2026-10-21. Scope: preparing a controller build, selecting its profile and workspace, connecting MCP, obtaining exact supervision, observing, stopping and resuming work. This review also delivers reusable tooling and the [Deszo Control skill](../../skills/deszo-control/SKILL.md).

The failed preparation was avoidable. The controller checked compilation and selected source tests but omitted the compatibility of the actual profile and packaged runtime. It then recreated client plumbing that already existed on another branch. The initial package supported schema 11; the selected profile had schema 12. No business run started under that package.

The detailed verification, identities and remaining limitations are recorded in [the evidence receipt](evidence/2026-10-21-deszo-control-review.json). Large raw logs remain under `.deszo/revisions/control-review-2026-10-21/`.

## Findings and corrections

| ID | Finding | Correction and evidence |
| --- | --- | --- |
| OP-01 | The ADR-6 source branch omitted migration 12 and supervised pending-request fixes already used by the selected profile. | Selectively integrated the relevant changes from `7ea63f7`, preserving the ADR-6 host-admission checks and dirty work. Migration 12 is the existing `run_request_controls` migration; no profile downgrade or historical-row rewrite was performed. Isolated tests reproduce the 12-versus-11 failure. |
| OP-02 | Successful tests/build commands were presented as readiness without testing the selected profile, artifact contents or live runtime. | Added [doctor and prepare](../../scripts/deszo-control.mjs), runtime/package manifests, actual input/file digests and preflight before preparation. Source readiness, packaged readiness, live connection and authority remain distinct. |
| OP-03 | Timeout checks were recreated in dated pilot directories and lost when a new application package used the unverified registry. | Added a maintained [stdio caller](../../mcp/stdio-client.mjs), [measurement/cache command](../../scripts/deszo-transport.mjs) and [saved receipt](../authoring/controller-transport.json). Cache identity covers the caller, policy, platform and Node major; app restarts and new tasks do not invalidate it. An identical measurement request returns from cache. |
| OP-04 | The old installed MCP integration could reconnect to a runtime while retaining an incomplete tool inventory. | Restored `RunObserver` and the complete bridge; added `get_control_grant`. The [controller client](../../mcp/controller-client.mjs) pins the reviewed store/bridge and checks the complete tool set. Real Codex Node REPL connection confirmed 43 tools. Its environment handling does not depend on a REPL `process` global. |
| OP-05 | Pending supervision and subsequent run approval did not work together in this branch. | A request captures the authenticated grant/session binding, which survives restart without storing the controller secret. Approval rechecks it and arms supervision before dispatch. The UI now displays supervision approvals and run control alongside the existing Autonomy UI. Foreign sessions, changed snapshots and stale client versions remain refused. |
| OP-06 | Earlier terminal-grant and paused-Stop fixes were also absent. | Reconciles terminal grants on restart, retains historical supervised mode, permits Root Stop while dispatch is paused, and prevents terminal ACKs from resuming dispatch or renewing a native lease. Regression tests cover these paths. The real previous Fixer run still reports supervised mode, an ended grant, a stopped outcome and no owned processes. |
| OP-07 | Recoverable Codex reconnect progress could be treated as a terminal error in this branch. | Restored the narrow diagnostic classification. A final successful event and successful process exit are still required; genuine errors remain failures. The previously verified Antigravity finish-contract fix and explicit efforts are preserved. |
| OP-08 | Worktree refresh was another one-off script, risking stale task inputs or overwritten developer work. | Added [guarded workspace planning/synchronization](../../scripts/deszo-workspace.mjs). A check is read-only. Synchronization requires the existing ownership manifest, matching Git bases, untouched target inputs, the registered binding and no unfinished runs. It preserves a content-addressed source snapshot and rejects unexpected edits/deletions. |
| OP-09 | Judge overhead was dominated by repetitive log events and repeated context reconstruction. | The skill uses compact observations, existing role loops and evidence on demand. The previous incident `acf78694-f8f8-4e90-8b69-5a67aed406c1` remains the product follow-up for a more efficient semantic observation projection. No automatic semantic ACK, cursor jump or background model monitor was introduced. |
| OP-10 | A failed launch could leave a public checkpoint suggesting that opening an old executable was the next action. | The current package locator and checkpoint now identify the reviewed build and live state. Checkpoints contain public IDs and evidence paths only; they do not restore approval or bridge-held credentials. |

## Why the versions diverged

The common base is `914c67dc588e1b177e324875b1139a544ff3daf7`. The active branch at `8efb0ca` contains ADR-6 work, while `codex/supervision-observation` at `7ea63f7` contains later operational fixes and migration 12. A complete replacement with that branch would discard ADR-6 work. The required changes were therefore integrated selectively.

Migration registration now has one [catalogue](../../runtime/core/migrations.mjs), shared by the store, bundle and operator preflight. The profile's applied migrations match that catalogue, including migration 12. Migrations 10 and 11 differ only in LF/CRLF encoding; the preflight recognizes those exact aliases without altering the stored digests. Other historical content changes block preparation.

## Maintained entry points

Run these from the Deszo checkout, with explicit profile and build paths:

```powershell
node --disable-warning=ExperimentalWarning scripts/deszo-control.mjs doctor --profile PROFILE --build BUILD --live
node --disable-warning=ExperimentalWarning scripts/deszo-control.mjs prepare --profile PROFILE --out BUILD
node scripts/deszo-transport.mjs
node scripts/deszo-workspace.mjs --from SOURCE --to TARGET --manifest MANIFEST
```

`doctor` does not launch an app, migrate a store, request a run or change approval policy. It reads SQLite through a read-only connection; SQLite shared-memory bookkeeping is not claimed byte-immutable. `--live` adds an authenticated read with a short bound. The actual MCP contract and run/grant state remain authoritative for execution.

`prepare` checks the profile first. It reuses a matching existing package, reuses an unchanged desktop binary when only bundled runtime inputs changed, and preserves incompatible previous outputs. Build input receipts bracket compilation. Runtime files and migrations are verified before the package is offered. Operator-only script changes do not force a native application rebuild; every actual compiled input is still compared. These are local reproducibility records, not ADR-6 protected build attestation.

Timeout measurement is explicit and uses no models. Normal checks validate the saved fingerprint. The measured policy is watch <=20 seconds, bridge HTTP 30 seconds, caller 45 seconds and enclosing Node REPL call at least 55 seconds. This receipt does not certify the desktop's built-in MCP host, other CLI transports or the autonomous worker. Only the explicit caller version is registered as verified for Codex; unknown clients remain unverified.

The skill is versioned in this repository and installed at `C:/Users/jusse/.codex/skills/deszo-control`. It does not introduce another scheduler or authorization service.

## Current state and remaining work

Verification completed: full runtime suite **611 passed, 0 failed**; final controller/tooling suite **13/13**; native Rust suite **13/13**; desktop build, documentation checks and skill validation passed. Operator-only refinements made after the full suite were covered by the final controller suite. A repeated preparation reused the same package in about 0.35 seconds; a repeated measurement command reused its saved receipt. Neither invoked a model or repeated compilation.

The user opened the standard reviewed package. Live MCP confirms store `93322f30-eefc-4a74-8023-b805f69e2018`, runtime `5a463739-3d9b-4a66-a259-94233dd9bd77`, `tauri-job` containment and the registered `deszo-fixer` workspace. The saved workflow remains revision 1, snapshot `e9a59fb978c566e2f182e9905004acc014966ff37f849187312161ecde51ec76`.

The Developer remains Claude Code `claude-haiku-5-5 / xhigh`, timeout 600 seconds. The Watcher remains Antigravity `gemini-3.8-flash-high / high`, timeout 300 seconds. The external Judge stays outside the Agent graph. No workflow revision, new grant, start request or model invocation was made by this review.

The compatibility/preparation incident is registered as `6b0d9868-c57f-449c-9962-08fcf454d4f5`. Its cause is confirmed and its state remains open; external observation filing does not perform first-party triage.

Before another business task, check the captured worktree using the guarded script and synchronize when needed, capture its source identity in one bounded task brief, validate/save that workflow revision and obtain actual authority for its exact snapshot. Do not reuse the canceled run or old dated proposal.

ADR 3–6 acceptance remains separate work through the chosen workflow. Protected-host consent, authority renewal, real lifecycle replacement, environment/lock/reboot tests, native UI acceptance and independent reviews retain their existing evidence requirements. This operational review does not close them. The live check here confirms application startup and MCP, not a new Developer/Watcher business run or native UI acceptance.
