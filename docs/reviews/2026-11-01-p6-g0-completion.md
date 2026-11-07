# P6-G0 completion report

Date: 2026-11-01
Branch: `codex/adr-0003-0005-completion`
Base HEAD: `1f54c47` (commit message `p5`)

Status of this document: final for the frozen snapshot `0937cf25…fc504` (790 files). No item is pending. The report itself is excluded from that digest.

## 1. Final verdict

Status note (G0-FINAL): this is the verdict of the G0 completion report at its own snapshot. The G0-FINAL verdict is in `docs/reviews/2026-11-01-p6-g0-final-acceptance.md`, and where this report and that one differ, the final report governs.

**VERIFIED WITH LIMITATIONS — NOT READY FOR P6-BUILD**

Basis, on the frozen snapshot `0937cf25…fc504` (790 files; the full digest is in section 26):
- The full Node suite passed 981 of 981 and the Lifecycle Host Rust suite passed 45 of 45 (section 20). The snapshot digest was unchanged across the run.
- The packaged Shell-S switch from Engine A to Engine B committed once, reached `verified`, and left the Shell and Host bytes unchanged (section 14). The packaged failed-B run restored the exact previous Engine once and never committed (section 15).
- 17 of the 18 G0 cases had a passing native or packaged test when this report was written; C09 was not exercised here and is exercised after G0-FINAL with a debug-only seam (sections 16 and 23).

Limitations that keep this short of P6-BUILD readiness:
- C09 (Engine A termination uncertain) is exercised after G0-FINAL with a debug-only seam (section 16).
- The independent review the specification requires has not been done. Section 22 is a self-review, disclosed as such.
- The limitations in section 23 stand, as corrected after G0-FINAL: the live Custody fence is exercised end to end, the legacy closure is covered through the installed Engine's own bridge, and Engine-internal Run creation is gated at `captureRun`.

## 2. Starting and final Git state

- Start: branch `codex/adr-0003-0005-completion`, HEAD `1f54c47`. The working tree already held uncommitted P5 closure work and earlier P6 foundations (the starting `git status` listed 23 modified tracked files and 27 untracked entries).
- No commit, push, stash, reset, clean, rebase or merge was run against the development checkout. Attribution lines were not needed because nothing was committed.
- Final: HEAD is unchanged. The working tree contains the same uncommitted work plus the P6-G0 changes listed in section 4. The final status is recorded in section 26.

## 3. Prior G0 work reused

- `docs/reviews/2026-10-31-p6-g0-minimal-host-compatibility.md`: the earlier feasibility report. Its baselines were Node 968/968 and Rust 33/33 before G0 began.
- `docs/reviews/evidence/2026-11-01-p6-g0-feasibility.json` and `scripts/p6-g0-feasibility-probe.mjs`: the Windows feasibility probe output and its script.
- `lifecycle-host/examples/p6_g0_file_guard_probe.rs`: the Windows file-share probe that the Store guard was built on.
- `docs/adr/0010-p6-trusted-build-activation-rollback.md`: the ADR, revised for the minimum G0 path (H-min).
- The P5 packaged-desktop harness (`runtime/tests/p5-e2e-support.mjs`), the Host's Job Object containment, the Custody registry and the managed Lifecycle Host protocol.

## 4. Exact production changes

Rust Lifecycle Host (`lifecycle-host/`)
- `src/engine_switch.rs` (new): Engine staging, the switch state machine, the maintenance hand-off, commit, precommit fallback and restart reconciliation.
- `src/store_guard.rs` (new): Windows share-mode guards on `state.sqlite`, `-wal`, `-shm` and `-journal`, and the disposable copy of the production Store.
- `src/p6_gate_tests.rs` (new, test-only): Host-level tests of the P6 gates.
- `src/custody.rs`: the switch fence (`set_fenced`), the zero-job proof (`active_job_count`) and the admission refusal `custody_fenced`.
- `src/lib.rs`: loading of `shell/shell.json`, binding of the Engine package to the Shell, schema-2 Engine build verification, spawning with a separate Shell root and an optional maintenance bootstrap, the Shell-identity check on readiness, refusal of legacy activation in P6 installations, reconciliation at start, debug-only crash points, and the `engine.*` dispatch arms.

Tauri Shell (`src-tauri/src/main.rs`)
- Bootstrap fields `shellBuildId`, `shellRoot` and `maintenance`; separate Shell and Engine roots; the maintenance candidate starts at setup; a longer startup wait for a maintenance candidate; `DESZO_SHELL_BUILD_ID` is passed to the Engine.

Node runtime (`runtime/`)
- `runner.mjs`: the `--p6-maintenance` entry point, which runs before ordinary startup; injection of the Host bridge; the G0 test trigger `POST /api/v4/lifecycle/engine-switch` (202, present only in test-marked packages); an admission gate that refuses every owner mutation that could start a Run while the Engine is quiescing and leaves settling routes open (Judge decisions, observation acknowledgements, escalation extensions, and the stop routes for runs, stop-and-report and nodes); conversion of switch refusals to stable API codes.
- `core/engine.mjs`, `core/workflowJudge.mjs`, `core/linkedRepair.mjs`, `core/testEngineProbe.mjs` and `core/testFaultPolicy.mjs`: the single `captureRun` admission barrier, the request-repair refusal at commit, the continuation resumes (their quiescence gates were removed in G0-FINAL), and the test-only probe and seam policy (section 25).
- `host/p6Maintenance.mjs` (new): the candidate's preflight on the disposable copy, read-only, with the migration and integrity checks, then the wait for the Host's decision.
- `host/p6Switch.mjs` (new): quiescence, settling of active Runs, and the `engine.stage` and `engine.switch` requests.
- `host/lifecycleBridge.mjs`: the optional Shell identity, the `p6Call` allow-list, longer timeouts for the P6 commands, and gating of the duplicate-receipt test hook behind the test-fault policy.
- `core/testFaultPolicy.mjs` (new): fault hooks are honoured only in source and test-built packages. Production packages ignore fault hooks from the environment (test `P6-G0 production bundles ignore environment fault hooks`).

Packaging (`scripts/desktop-release.mjs`)
- `packageShellRelease` (Shell package with `shell.json`) and `packageEngineRelease` (Engine package, `build.json` schema 2, with no `deszo.exe`).

Tests
- New: `runtime/tests/p6-g0-support.mjs`, `p6-g0-identity.test.mjs` (M1), `p6-g0-switch.test.mjs` (success and failed-B), `p6-g0-recovery.test.mjs` (G0-C01 to C18 native matrix), `p6-g0-admission.test.mjs` (admission fence), `p6-g0-fault-hooks.test.mjs`.
- Modified: `amd19-authorization.test.mjs` (route inventory: public 97, internal-host 5, retired 4, total 106, and the switch route is an Owner-Token route), `p5-e2e-support.mjs` (a longer client ceiling for the publication POST, and provenance-checked desktop build inputs), `tiers.json` (heavy tier entries for the P6-G0 files).
- Files already untracked at session start and reused: `runtime/tests/desktop-build-receipt.test.mjs`.

## 5. M1 identity split

- The stable Shell is `installation/shell/` (`deszo.exe`, `shell.json`, frozen runtime resources). Its compiled identity is `shell-g0`, built with `DESZO_DESKTOP_BUILD_ID=shell-g0` and `testFaultHooks` false.
- Each Engine is `installation/versions/<engineBuildId>/`, a schema-2 Engine package with bootstrap `engine` and a bound `shellBuildId`. It contains no `deszo.exe`.
- The bootstrap names the Shell identity (`shellBuildId`), the Shell directory (`shellRoot`) and the Engine directory (`applicationRoot`). The Shell refuses a bootstrap whose Shell identity differs from its compiled identity, or whose Engine root equals its Shell root.
- An Engine's readiness names its Shell identity, and the Host refuses a mismatch.
- Test `P6-G0 M1`: PASS. One unchanged Shell launches Engine A and then Engine B. The Shell and Host bytes are identical before and after both runs.

## 6. M2 Engine-only staging

- `engine.stage` records its intent (phase `staging`) before the first byte is copied (G0-C01). It copies the package to `versions/.incoming-<operation>`, verifies the digest, renames it into `versions/<engineBuildId>`, verifies the binding, and records phase `staged`.
- Staging is idempotent for one operation identity. A different package under the same identity is refused as `engine_identity_conflict`.
- Staging never writes the selector (`.deszo-host/active.json`).

## 7. M2 durable switch

Phases, in order: `staging` → `staged` → `fenced` → `a_stopped` → `guarded` → `preflight_running` → `preflight_passed` → `committing` → `committed` → `verified`. Other terminal or held phases: `rolled_back`, `abandoned`, `held`, and `fallback_a` (transient).

- `POST /api/v4/lifecycle/engine-switch` (Owner Token, test-marked packages only; a G0 test trigger, not a production interface). The active Engine quiesces, waits for its active Runs to settle (60 s), asks the Host to stage, then asks the Host to switch. The response is 202 with phase `fenced`. A production package has no route that starts a switch.
- `engine.switch`: the Host fences Custody and proves zero active jobs, persists `fenced` and accepts the request. A worker thread then waits a 1.5 s grace period, ends the managed Engine tree through its containment, persists `a_stopped`, takes the Store guards and the disposable copy, persists `guarded`, and starts the candidate's maintenance preflight (`preflight_running`). The Host waits up to 120 s for the candidate's report (`preflight_passed`).
- Before the commit the Host verifies that the guarded production files are unchanged and that the candidate process and package are still the staged ones. Then it performs one atomic write of `active.json` with `committedOperationId`. That write is the single commit point. The Host releases the guards, persists `committed`, unfences Custody, waits for the candidate's readiness, and persists `verified`.
- The operations journal records these events in order: `engine_staged`, `engine_switch_accepted`, `managed_process_tree_stopped`, `engine_preflight_passed`, `engine_store_boundary_verified`, `engine_switch_committed`, `engine_switch_verified`.

## 8. Custody fence

- `Inner.fenced` is set by the switch. While it is set, `reserve` refuses with `custody_fenced`.
- `active_job_count` counts pending, live and undrained invocations. The switch refuses with `custody_jobs_active` when that count is above zero, and releases the fence.
- Native tests: `p6_fence_counts_live_jobs_and_refuses_new_admissions` (`lifecycle-host/src/custody.rs`) and the Host-level custody-holds-work refusal in `p6_gate_tests`. Both PASS.
- Limitation: the packaged switch runs do not configure Custody, so the fence with live jobs is not exercised end to end. See section 23.

## 9. Store guarded-copy integration

- `store_guard::guard_and_copy_store` opens `state.sqlite`, `-wal`, `-shm` and `-journal` with read-sharing handles. It refuses when a rollback journal exists. It copies `state.sqlite` and `-wal` into `.deszo-host/p6/<operation>/preflight/`.
- `verify_unchanged` runs before the preflight result is accepted, again before the commit, and again before any fallback.
- The live Store is never preflighted. The candidate reads only the disposable copy, and the Host checks the copy's SHA-256 against its own record (`copySha256`).
- No SQLite snapshot is ever restored, and the live Store is never restored automatically.

## 10. Maintenance preflight

- The candidate starts with `--p6-maintenance` before ordinary startup. It does not open the production Store.
- It hashes the disposable copy, opens the copy read-only, checks `schema_migrations` against the installed catalogue (raw, LF and CRLF digest forms are accepted) and runs `PRAGMA quick_check`.
- It reports `engine.maintenance_ready` with its process identifiers, identities, the copy digest, the migration count and the integrity result. The Host verifies the process parentage (desktop), the identities and the copy digest.
- It then waits in the same process for `engine.maintenance_wait`. Only `commit` lets it continue into ordinary startup. Any other answer ends it.

## 11. Precommit A fallback

- `fallback_to_a` runs only before the commit. It first proves the candidate tree ended, then requires the guards to be held and the production set unchanged. It is allowed once per operation (`fallback_attempted`).
- The guards are released before Engine A opens the Store. Engine A is restarted at the current durable generation. Success records `rolled_back`. Failure records `held`.
- After the commit there is no rollback. A failure after the commit is recorded beside the committed phase, and the selection stays with B.
- A failure to establish the guards after A has stopped holds the switch rather than restarting A. Without guards the Host cannot prove the production Store unchanged, so it does not restart A. This is a deliberate conservative choice and is listed in section 23.
- Restart reconciliation (`reconcile_at_start`, as corrected after G0-FINAL): `staging` and `staged` clear the incoming bytes and keep the operation resumable under the same identity; a stage that fails after its intent is `abandoned`; a staged or interrupted stage that never switched is superseded by the next stage (`engine_stage_superseded`). Neither blocks a later switch. `fenced` holds unless every process recorded with the fence (the managed root and each Job member taken at the fence and refreshed after the grace period) is proven gone within a bounded wait; a proven end makes it `abandoned` and the committed Engine starts. `a_stopped` becomes `abandoned` and the committed Engine starts, because the Host records `a_stopped` only after the tree was proven ended in the same session. `guarded` through `committing` without a committed selector become `rolled_back` once if the production set is unchanged and fallback is unused, otherwise `held`; `committing`/`committed` with the selector naming this operation become `committed` and the selector's generation is adopted; `fallback_a` becomes `rolled_back`; `held` stays held and resumes only on fresh proof of the recorded processes (C09), with one exception (M5): a hold recorded after `a_stopped`, with no unproven record and no candidate preflight, becomes `abandoned` and the committed Engine starts, because no candidate ran and the Store was not written. A managed Engine that leaves the Host's records before or during its stop is recorded as unproven, with the hold, in one durable write (the HELD arm), and is proven only at a restart. The earlier wording, which started the committed Engine on `fenced` without proof, is withdrawn (section 22).

## 12. Legacy bypass closure

- `lifecycle.activate_candidate` is refused in any P6 installation (one with `shell/shell.json`) as `p6_legacy_activation_refused`. The refusal happens before staging, stopping or any selector write.
- This is the only command that reaches the legacy activation path.
- Native test in `p6_gate_tests`: PASS. The installed Engine's own production bridge sends the legacy activation through the Host (`p6-g0-legacy-installed.test.mjs`); the Shell window itself is not probed (section 23, item 3).

## 13. Protocol and schema changes

- Host commands (the Node `p6Call` allow-list): `engine.stage`, `engine.switch`, `engine.switch_status`, `engine.maintenance_ready`, `engine.maintenance_wait`.
- Test trigger: `POST /api/v4/lifecycle/engine-switch` (public, Owner Token) exists only in source runs and test-marked packages; production packages do not register it. The source AMD-19 inventory still counts it: public 97, internal-host 5, retired 4, total 106.
- Stable codes: `switch_in_progress` (503), `switch_not_quiescent` (409), `switch_refused` (409), `invalid_request` (400), `custody_fenced`, `custody_jobs_active`, `engine_identity_conflict`, `stale_generation`, `stale_engine`, `another_engine_operation_active`, `operation_replayed`, `p6_legacy_activation_refused`, `p6_unavailable`, `shell_mismatch`, `engine_package_digest_mismatch`, `preflight_refused`.
- `shell/shell.json` (Shell identity and frozen resources). `build.json` schema 2 for Engine packages (`engineBuildId`, `shellBuildId`, `sourceCommit`, runtime bundle digest; no `deszo.exe`).
- `.deszo-host/active.json`: `buildId`, `digest`, `generation` and the optional `committedOperationId`.
- `lifecycle.json`: the optional `engineOperation` record (serde default, absent for legacy installations).
- Journal events added: `engine_staged`, `engine_switch_accepted`, `engine_preflight_passed`, `engine_store_boundary_verified`, `engine_switch_committed`, `engine_switch_verified`, `engine_switch_rolled_back`, `engine_switch_held`, `engine_start_held`, `engine_operation_reconciled`. Debug-only: `test_switch_crash_point`.
- Shell bootstrap: `shellBuildId`, `shellRoot`, and `maintenance` with `operationId` and `preflightStore`.

## 14. Main packaged Shell-S A-to-B evidence

- Evidence file: `docs/reviews/evidence/2026-11-01-p6-g0-switch-evidence.json`, written on the frozen snapshot (`capturedAt` 2026-11-01T09:26:36Z) by a one-off scratch script outside the repository.
- Test: `P6-G0 switch` in `p6-g0-switch.test.mjs` (PASS in the frozen full run, ok 692).
- Values: trigger HTTP 202 with phase `fenced` and staged phase `staged`; final phase `verified`; `fallbackAttempted` false; selector `engine-a` → `engine-b`, generation `8feca578-08ac-41e5-ba3a-8592af63ad4a`, `committedOperationId` `f95e307e-6951-4668-acec-d137fe4cf73b`; Engine A (PID 20420) not alive after the switch; Engine B (PID 3148) not alive after the Host stopped; the disposable copy kept under `.deszo-host/p6/<operation>/preflight/`; the production `state.sqlite` SHA-256 `a536ebc2f686a1b83ec2f78cca54fa11122ccc343792a655e1b64d8c4823f6cf` before the switch and at the Store boundary, equal to the copied state.
- Journal order: `host_started`, `application_spawned` (A), `engine_ready` (A), `engine_staged`, `engine_switch_accepted`, `managed_process_tree_stopped`, `application_spawned` (B), `engine_preflight_passed`, `engine_store_boundary_verified`, `engine_switch_committed`, `engine_switch_verified`, `engine_ready` (B), `managed_process_tree_stopped`, `host_stopped`.

## 15. Failed-B packaged evidence

- Test: `P6-G0 switch negative` in `p6-g0-switch.test.mjs`. The candidate fails at module load, before its maintenance report. The Host restores the exact previous Engine once. PASS in the frozen full run (ok 693).
- Evidence file: `docs/reviews/evidence/2026-11-01-p6-g0-failed-b-evidence.json`, written on the frozen snapshot (`capturedAt` 2026-11-01T09:28:04Z).
- Values: trigger HTTP 202; final phase `rolled_back`; failure `the candidate exited before its preflight result with status exit code 1`; `fallbackAttempted` true; selector `engine-a` before and after, with no `committedOperationId`; zero `engine_switch_committed` events; launches in order: Engine A (PID 23276, not alive), Engine B (PID 27592, not alive), Engine A restored (PID 30820, not alive after the Host stopped); the copied state and the production Store both `101dce63c4c1b84daa4066fd45d2720101bf17e9502c34c558e910aa2490bee3` before the switch and at the boundary; Shell and Host SHA-256 unchanged.
- Assertions in the test: the selector stays on `engine-a` with no `committedOperationId`; no `engine_switch_committed` event; phase `rolled_back`; `fallbackAttempted` true; the candidate was launched once; the last launch is the exact previous Engine; the Host executable is unchanged.

## 16. G0-C01 to C18 matrix

Each case is exercised by a native crash point (a debug-only seam, honoured only by a debug Host) or by a packaged run. "PASS" refers to the frozen full run recorded in section 20 (ok 679 to 693), which predates `p6-g0-c09.test.mjs`. The C09 entry refers to the G0-FINAL packaged runs, whose evidence is cited in the final acceptance report.

| Case | Scenario | Mechanism | Test | Result |
|---|---|---|---|---|
| C01 | Stage intent before the first file | crash `after_stage_intent` | `G0-C01/C02/C03` | PASS |
| C02 | Stage copy partially completed | crash `after_stage_intent` plus a truncated incoming directory written by the test (a crash inside the copy was not produced) | `G0-C01/C02/C03` | PASS (simulated bytes) |
| C03 | Stage finalized before the stage record | crash `after_stage_copy` (package installed, record not written) | `G0-C01/C02/C03` | PASS |
| C04 | Switch request persisted | crash `after_fenced` (the fenced request is durable) | `G0-C04/C10` | PASS (shared point with C05, C06) |
| C05 | Custody fence begins | crash `after_fenced` (fence set and persisted) | `G0-C04/C10` | PASS (shared point; the native fence test covers the live-job case) |
| C06 | A quiescent but not stopped | crash `after_fenced` (Engine A still running) | `G0-C04/C10` | PASS (shared point) |
| C07 | B maintenance preflight running | crash `after_candidate_spawned` | `G0-C07` | PASS |
| C08 | B preflight fails | packaged candidate that fails at module load before its report (`failing` variant) | `P6-G0 switch negative` | PASS (not a crash point) |
| C09 | A termination uncertain | exercised with a debug-only seam that withholds the emptiness proof after the real termination: the hold, the restart without proof, the restart with proof, and a crash after the fence (`p6-g0-c09.test.mjs`) | `P6-G0 C09` tests | PASS (debug seam) |
| C10 | A terminated before the B commit | crash `after_a_stopped` | `G0-C04/C10` | PASS |
| C11 | Host exits before the selector commit | crash `before_commit_write` | `G0-C07/C11` | PASS |
| C12 | Host exits after the selector commit | crash `after_commit_write` | `G0-C12/C13/C18` | PASS |
| C13 | Commit succeeds, acknowledgement lost | crash `after_committed_phase`; the Owner's response may or may not have arrived (the test tolerates a lost response) | `G0-C12/C13/C18` | PASS (partial: the acknowledgement loss is modelled as a Host death after the committed phase) |
| C14 | B exits during the transition | packaged candidate that exits after its preflight report and before the decision | `G0-C14` | PASS |
| C15 | A fallback interrupted | crash `before_fallback_start` with a failing candidate | `G0-C15` | PASS |
| C16 | Production Store identity changes | crash `after_guard`, then the production file is changed while the Host is down | `G0-C16` | PASS |
| C17 | Concurrent switch requests | two concurrent requests | `G0-C17` | PASS (exactly one 202 and one 409) |
| C18 | Repeated Host restart | two further restarts after the committed crash | `G0-C12/C13/C18` | PASS |

Summary: 17 of 18 cases had a passing native or packaged test when this report was written. After G0-FINAL, C09 has its packaged tests, so all 18 have one. C05, C06 and C13 share a crash point with a neighbouring case and are partial.

## 17. Source, build and package identities

- Shell: compiled identity `shell-g0`; build receipt `desktopBuildId` `shell-g0`, `testFaultHooks` false, `desktopInputsSha256` `6b3aba3a0cc30960977614b2f0f4b36335df54266bc85cd4b24ece86d907c0e9`, `runtimeManifestSha256` `d66f2afd547d281a53045485cd491d3d83fadcd0ae46979a26c7dcc4579bcae6`, `exeSha256` `60cd2526f37c649d444aeeee74f150a62b32fe53d649cac8e2607f1ddbd72dbe`, built 2026-11-01T04:45:16Z.
- Engine A: `engineBuildId` `engine-a`, a test-owned clean clone of the base commit, packaged by `packageEngineRelease`. Engine B: `engineBuildId` `engine-b`, the same base commit plus one Engine-only marker commit.
- Switch run: Engine A `sourceCommit` `25cf8f8e46ca66dfe96a08cd95fd7a181966e143`, `runnerSha256` `1c947140416eb5f31325274901f90c194095415ce286e539851c7f2f5da955f7`, `packageSha256` `425aa77de5d349622b62f9ac71096da331b12933f45e18230d7016761eb93104`. Engine B `sourceCommit` `f342202f3e400ad71e19d202442edb7b30204b1f`, `runnerSha256` `c442d429cccda6d53342ae866014434fffc988157dc7cc6ea8e31c026cd61a80`, `packageSha256` `f3ce0add6b1f1ad3e2f5ab86a92eaf4a39e4696b617c71eae0cc30beb1866695`.
- Failed-B run (its own test-owned clones): Engine A `sourceCommit` `2919dca14c8e9d801dd13e3ac9c12116c8f25cba`, `packageSha256` `89b9744c613dd18d1ea0b299004da6b6735272cf239985f08da59615663f11f2` (the same `runnerSha256` as the switch run); failing Engine B `sourceCommit` `b7967bdd5c43c96272229f7f472e8549a1f693d0`, `packageSha256` `f2c988022b92c5f290e08da19893de50245674f6cb5e52b00876cc0dcc80f189`. Each run creates new clone commits, so the package digests differ between runs.
- Host: debug build `lifecycle-host/target/debug/deszo-lifecycle-host.exe`, SHA-256 `190efe9beda1edb019f6b3db97532a890cb9d5c3445c6df73d4f9774056b2a56`, used by the native tests.

## 18. Actual Host and Shell digests

- Switch run (frozen evidence): Shell `deszo.exe` SHA-256 `60cd2526f37c649d444aeeee74f150a62b32fe53d649cac8e2607f1ddbd72dbe` before and after the switch; Host executable SHA-256 `190efe9beda1edb019f6b3db97532a890cb9d5c3445c6df73d4f9774056b2a56` before and after. Both unchanged.
- Failed-B run (frozen evidence): the same Shell and Host values before and after. Both unchanged.

## 19. P5 regression

- Full run 1 (980 tests: 973 pass, 7 fail). The seven failures and their resolution:
  - `P5-FINAL-ENGINE-CORE`, `P5-FINAL-P5-MODULE`, `P5-FINAL-NEG-AUTHORIZATION`, `P5-FINAL-JUDGE-QUESTION`: caused by P6 Host modules importing `runtime/core`, which the P5 host import closure refuses. The core imports were removed. All four pass in the targeted run.
  - `AMD-19 inventories every route`: the route count was updated for the switch route. An intermediate version of the assertion used an escaped-slash filter, which matched nothing. The current assertion passes alone (5 of 5).
  - `F7 (reverse)`: timing-sensitive. Passed on the targeted rerun.
  - `P5-CLOSURE-DESKTOP`: the publication POST received no response headers within undici's fixed 300 s timeout. The publication admission re-verifies the installed package for each source-inventory batch in a debug Host, which takes about five minutes. The harness now sends this one request with a 20-minute ceiling. The case passes alone in 305,982 ms.
- Frozen full run (section 20): every P5-named case passes. That is 54 cases whose names contain `P5` (ok 536–537, 642–678, 681, 761–774), with none failing. The seven cases that failed in full run 1 all pass: `P5-FINAL-ENGINE-CORE` (ok 646), `P5-FINAL-P5-MODULE` (ok 647), `P5-FINAL-NEG-AUTHORIZATION` (ok 658), `P5-FINAL-JUDGE-QUESTION` (ok 659), `AMD-19 inventories every route` (ok 101), `F7 (reverse)` (ok 485), and `P5-CLOSURE-DESKTOP` (ok 648, 299,682 ms).
- `P5-CLOSURE-DESKTOP` takes about five minutes on this machine, the same order as the undici 300 s limit that failed in full run 1. Its publication request now uses the harness's own 20-minute ceiling (section 23, item 8).

## 20. Node and Rust regression

- Baselines: the 2026-10-31 report recorded Node 968/968 and Rust 33/33.
- Full run 1: 980 tests, 973 pass, 7 fail (section 19). The later targeted runs pass for every failing test once its cause was fixed.
- Frozen `npm test` (full tier) on snapshot `0937cf25…fc504`: 981 tests, 981 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo. Duration 10,841.7 s (about 181 minutes; started 12:29:47, finished 15:30:30 local time; exit 0). Full run 1 recorded 980 tests; the one-test difference was not traced.
- Frozen `cargo test --manifest-path lifecycle-host/Cargo.toml`: 45 passed, 0 failed, 0 ignored in the library target (1.93 s). The binary target and the doc-tests run 0 tests. Exit 0. The source tree has 45 `#[test]` attributes. The 2026-10-31 baseline was 33/33, and the HEAD commit carries 27 test attributes in `lib.rs` and `custody.rs`, so the change from 33 to 45 is not reconciled test by test.
- Frozen `npm run test:tiers`: 95 files (55 quick, 34 integration, 6 heavy), no problems.
- Frozen `npm run build` (`tsc -b && vite build`): completed; Vite built in 4.53 s. Vite warned that the main bundle (696 kB minified) is above its 500 kB chunk-size advice. This is a warning, not an error.
- `git diff --check`: exit 0 for the tracked changes (section 26).

## 21. Desktop package validation

- Shell package: `shell.json` present; the receipt has `testFaultHooks` false and `desktopBuildId` `shell-g0`; the runtime manifest digest matches the receipt; the Host refuses a readiness that names another Shell identity.
- Engine packages: `build.json` schema 2; no `deszo.exe`; the Shell identity is bound.
- Production policy: test `P6-G0 production bundles ignore environment fault hooks while source tests retain them` PASS.
- `desktop-build-receipt.test.mjs` in the frozen run: `desktop release provenance binds the compiled shell, runtime manifest, build identity, and production fault-hook mode` passes (ok 528).

## 22. Independent review findings

- This is the G0 self-review. The independent reviews of the G0-FINAL changes, and their dispositions, are in `docs/reviews/2026-11-01-p6-g0-final-acceptance.md`, section 18; that section supersedes this one for the review record.
- Findings and their disposition:
  1. Admission gap: the first version refused new Runs only on `POST /api/v2/runs`. Chat messages and other owner mutations could still admit work during quiescence. Fixed by a general gate for every public mutation except the switch request itself, with the test `P6-G0 admission` (PASS). Internal-host routes are not gated, because the Host must complete the Judge attempts that the settle waits for.
  2. The legacy closure is confirmed by reading the single activation dispatch path.
  3. Hold versus fallback after a guard failure: the design holds rather than restarting A without guards (section 11). Documented; a limitation.
  4. Custody fence in the packaged path: the packaged runs do not configure Custody. Documented; a limitation.
  5. Engine-internal Run creation (linked repair continuation and Judge follow-up) was not admission-gated in the G0 self-review. G0-FINAL gates it at `captureRun`: the single `INSERT` into `runs` runs after the quiescence check in the same synchronous turn. Work admitted before quiescence keeps settling, and the switch waits for it up to 60 s.
  6. The Shell holds its runtime state lock during a maintenance candidate's wait, which can last up to 20 minutes. Documented; a limitation.
- Reviewer's limitation: the review was not independent of the implementation.

## 23. Remaining limitations

1. C09 (A termination uncertain) is exercised only through a debug-only seam that withholds the emptiness proof after the real termination (section 16).
2. The packaged switch runs do not configure Custody. The packaged Custody E2E test (`p6-g0-custody-e2e.test.mjs`) configures Custody and holds a switch on a live Job and its descendant.
3. The legacy closure is covered by the Host-level test and by the installed Engine's own production bridge (`p6-g0-legacy-installed.test.mjs`). The Shell window itself is not probed.
4. Engine-internal Run creation is gated at `captureRun` after G0-FINAL (see section 22, item 5). Work admitted before quiescence keeps settling, and a switch that cannot settle it within 60 s is refused.
5. A failure to establish the Store guards after A has stopped holds the switch. A is not restarted until a restart reconciles it.
6. The Shell holds its runtime state lock during a maintenance candidate's wait (up to 20 minutes). A window close during that wait is not handled specially.
7. C02 uses simulated partial bytes, and C13 models the lost acknowledgement as a Host death after the committed phase.
8. The publication POST needs a 20-minute ceiling in the P5 harness. The product's own client timeouts for this call were not checked.
9. All tests run on Windows against a debug Host. A release Host was not tested for timing.
10. The G0 completion review was a self-review (section 22). The independent reviews of the G0-FINAL changes are in the final acceptance report.
11. The fence records the managed tree with the fenced write and refreshes it after the grace period. A process the tree starts during the stop is covered by the restart proof only if it is in the refreshed record; if the Host dies mid-stop, kill-on-close is the only cover for anything later.
12. A member that exits between the Job query and its creation-time read is recorded without a creation time. A restart then holds on that record (fail closed) rather than proving it.
13. The stage-abandon path (a copy or rename failure after the intent) has no native test: no injection seam exists for those failures. It is verified by code review.
14. A managed Engine that leaves the Host's records before or during the switch's stop is recorded as unproven and holds. The hold is cleared by the next restart's proof of that tree, not in the same session (C09).
15. If the Host dies between a superseding stage's intent and its cleanup, one `.incoming-<superseded operation>` directory can remain, and the `engine_stage_superseded` event is not written. This is disk residue with no effect on any switch or selection.

## 24. Separate Host deployment requirements

- A switch does not change the Host executable. Its digest is recorded before and after each run.
- The Host is deployed separately from the Shell and the Engine packages. Test-only fault hooks exist only in debug Hosts and in test-built packages. A production Host must be built without them.
- The Host needs Custody configured for installations that run live Custody jobs. The G0 packaged runs did not configure it.
- The installation layout required is: `shell/` (with `shell.json`), `versions/`, `staging/`, and the Host's `.deszo-host/`.

## 25. Exact P6-BUILD handoff contract

Invariants that P6-BUILD must keep:
1. `.deszo-host/active.json` is the only selector. Staging never writes it.
2. A switch commits only after the candidate's maintenance preflight reports on the disposable copy, with identities the Host has checked.
3. The live Store is never preflighted, never restored from a snapshot, and never used for a fallback without the guard proof.
4. Fallback to the previous Engine is allowed only before the commit, once per operation, and only with the production set proven unchanged.
5. `lifecycle.activate_candidate` stays refused in P6 installations.
6. Restart reconciliation follows section 11 exactly.

Interfaces to build on: the Host commands `engine.stage`, `engine.switch` and `engine.switch_status` (section 13), the journal events, the `engineOperation` record, and the `build.json` schema 2 and `shell.json` formats. The owner route is a G0 test trigger and is not an interface P6-BUILD builds on; the production trigger is the P5 handoff, which calls the same Host commands after its own eligibility check.

**Correction (G0-FINAL, 2026-11-01).** The previous wording of this section named Owner approval flows, package attestation, an update channel and a Host update path as P6-BUILD work, and named the owner route as an interface. ADR-0010 section 12 removes Owner approval after an eligible accepted P5 handoff, section 6 forbids a new lifecycle service or updater daemon, and a Host update path is not part of P6. The corrected handoff contract is in `docs/reviews/2026-11-01-p6-g0-final-acceptance.md`, section 21.

## 26. Final repository state

- HEAD: `1f54c47`, unchanged. No commit, push, stash, reset or clean was performed.
- Generated and ignored: `src-tauri/target/`, `lifecycle-host/target/`, `dist/` (written by `npm run build`), `dist-runtime/`, `.deszo/`.
- Evidence written: `docs/reviews/evidence/2026-11-01-p6-g0-switch-evidence.json` and `docs/reviews/evidence/2026-11-01-p6-g0-failed-b-evidence.json`.
- Source snapshot identity: before the frozen regression, the snapshot digest is `0937cf25ac3d7021c811b9361ea0f09c3a92e45a8d414f96e86955b4e51fc504` over 790 files (`git ls-files --cached --others --exclude-standard`, excluding the completion report and the packaged evidence files). It was rechecked unchanged after the evidence runs and before the full `npm test` started. It was recomputed after the full `npm test`, and again after `cargo test`, `npm run test:tiers` and `npm run build`; both times it was unchanged: `0937cf25ac3d7021c811b9361ea0f09c3a92e45a8d414f96e86955b4e51fc504` over 790 files. The after-digest equals the before-digest.
- Leftover processes, checked after the last test command: no Deszo Shell (`deszo.exe`), Lifecycle Host (`deszo-lifecycle-host.exe`) or runner process from this run remains. Left running and not touched: the Deszo Control Host processes under `C:\Program Files\Deszo Control Host`, Codex runtime `node_repl` processes, and a Next.js dev server under `C:\my\2026\deszo_agicode_site`, which is a different project.
- `git status --short`: 23 modified tracked files and 27 untracked entries, 50 in total. The counts match the starting status. HEAD is `1f54c47`. Nothing was committed, pushed, stashed, reset, cleaned or rebased.
- Trailing spaces: nine lines in four untracked review documents from 2026-10-30 and 2026-10-31 end in exactly two spaces, which is the Markdown line break. Those documents predate the G0 work and were not edited. `git diff --check` exits 0 for the tracked changes; its LF/CRLF messages are line-ending notices, not errors.
