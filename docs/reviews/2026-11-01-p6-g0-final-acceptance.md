# P6-G0-FINAL acceptance report

This report is the G0-FINAL acceptance record. It supersedes the verdict of `docs/reviews/2026-11-01-p6-g0-completion.md`, which states its own snapshot. All numbers below come from the frozen-snapshot regression and the evidence files named in each section.

## 1. Final verdict

**P6-G0 VERIFIED WITH LIMITATIONS — NOT READY FOR P6-BUILD**

Basis, on the frozen snapshot `7bcb4e992f2772ff7effafb92b36cee8bbd4771a43097b7f7016e86b16701410` (796 files; digest identical before and after the regression):

- Full Node regression: 995 tests, 995 pass, 0 fail, 0 cancelled, 0 skipped (section 15).
- Lifecycle Host Rust suite: 46 tests, 46 pass (section 16).
- All 29 P6-G0 packaged and in-process tests pass in the same run, and every G0 case C01 to C18 has a passing test (sections 9 and 14).
- Packaged switch from Engine A to Engine B commits once, reaches `verified`, and leaves the Shell and Host bytes unchanged. A failed candidate restores the exact previous Engine once and never commits (sections 5, 13 and evidence `switch`, `failed-b`).
- A live Custody Job and its descendant hold a packaged switch; a racing admission is refused by the fence; the switch commits once after the Job ends (section 6).
- A legacy activation sent by the installed Engine's own production bridge is refused by the Host, with no effect (section 8).
- The owner switch route is absent from production packages (HTTP 404 in a packaged Engine without the test marker) (section 11).
- Independent review over four rounds found no High finding. Every Medium finding was fixed; the Low findings were fixed or recorded as limitations (sections 18 and 19).

Why the verdict is not READY. The target was READY. It is not met for these reasons, each recorded in section 20:

1. G0-C09 (uncertain termination of Engine A) is exercised through a debug-only seam that withholds the emptiness proof after a real termination. A native uncertain termination of a real process tree was not produced.
2. The production switch trigger is absent by design. P6-BUILD must add the P5-handoff trigger; G0 proves the switch machinery through test-marked packages only.
3. The Shell's own window path is not probed end to end. The installed Engine's bridge is probed.
4. The stage-abandon path (a copy or rename failure after the stage intent) has no native test; it is verified by code review.

None of these is a failing test. They are the reasons the G0 gate cannot be declared ready for P6-BUILD.

## 2. Starting and final Git state

- Starting state: branch `codex/adr-0003-0005-completion`, HEAD `1f54c47fe265c6b47bf36695be56214056fc3af1` (commit `p5`, 2026-10-30). The working tree had uncommitted P5 and P6 work (tracked modifications and untracked files, as listed by `git status` at the start of this session).
- Final state: the same branch and the same HEAD. No commit, push, reset, stash, rebase or merge was made.
- Final working tree: `git status --short` lists 73 entries: the 59 entries present at the freeze plus 14 new evidence files under `docs/reviews/evidence/`. Log files are ignored by the repository's ignore rules, so the regression logs are on disk but do not appear in `git status`.

## 3. Exact baseline

- The G0 completion report's own frozen snapshot is `0937cf25ac3d7021c811b9361ea0f09c3a92e45a8d414f96e86955b4e51fc504` (790 files). At that snapshot the Node suite passed 981 of 981 and the Rust suite passed 45 of 45 (completion report sections 1 and 20).
- The G0-FINAL frozen snapshot is `7bcb4e992f2772ff7effafb92b36cee8bbd4771a43097b7f7016e86b16701410` (796 files), computed by `scratchpad/snapshot.mjs`. The script hashes every tracked and non-ignored file and excludes the completion report, this report and the `2026-11-01-p6-g0-*` evidence files, so the report and evidence can be written after the freeze.
- Digest before the regression: `7bcb4e99…` (796 files). Digest after the regression: `7bcb4e99…` (796 files). They are identical.

## 4. Changes implemented

Lifecycle Host (`lifecycle-host/src`):

- `engine_switch.rs` (new): the switch state machine. Stage writes its intent before any copy; a stage that fails after its intent is abandoned; a stage that never switched is superseded by the next stage. The switch fences Custody and records the managed tree in the same locked write that persists `fenced`. The worker waits a grace period, refreshes the tree, stops it with a proof, records `a_stopped`, takes the Store guards, runs the preflight on the disposable copy, and commits once. Restart reconciliation is phase by phase (section 10 and completion report section 11). `in_flight()` decides which phases hold the Host's exit detection.
- `lib.rs`: the Host's exit detection uses in-flight phases only; spawn refuses while a managed or unproven process exists, and the check happens before the spawn; the `ProcessIdList` read is bounded (finding L-5); an Engine package is refused on an installation without its Shell (both at staging and as the initial build); a switch-path stop with no recorded managed process is refused; the `expect` calls on the Shell root are errors; debug-only test seams are validated and refused in release configurations.
- `custody.rs`: the native identity helpers (`creation_time_of`, `identity_alive`), the environment block with the double terminator, and the early fence refusal in `reserve`.
- `store_guard.rs` (new): share-mode guards on the production SQLite files and the disposable copy.
- `p6_gate_tests.rs` (new, test-only): host-level gate tests. The supersession contract is asserted here.

Node runtime (`runtime`):

- `runner.mjs`: the G0 switch route is registered only in packages built with the test marker; the admission gate refuses every owner mutation that could start a Run while the Engine is quiescing, and exempts the settling routes (Judge decisions, observation acknowledgements, escalation extensions, and the stop routes for runs, stop-and-report and nodes); the test probe is started only in test packages.
- `core/engine.mjs`: `captureRun` is the single admission barrier. It is the first statement and the only `INSERT INTO runs`.
- `core/workflowJudge.mjs`: the Judge dispatch gate was removed (settling work runs); a decision that would admit a Repair Run is refused at commit.
- `core/linkedRepair.mjs`: the continuation quiescence gates were removed; `resumeDeferredContinuations` was removed.
- `host/p6Switch.mjs` (new): `requestEngineSwitch` (settle with a 60 s bound, stage, switch, confirm by re-sending the same request after a lost reply, and the same-target status answer), with the refusal classes `SwitchRefusal` and `SwitchUncertain`.
- `host/lifecycleBridge.mjs`: the allow-list for P6 commands, the Custody command, the legacy activation path, and the test-seam policy.
- `host/p6Maintenance.mjs` (new): the candidate's preflight on the disposable copy, read-only.
- `core/testEngineProbe.mjs` and `core/testFaultPolicy.mjs` (new): the test-only probe and the package policy for the test seams.

Tauri Shell (`src-tauri/src/main.rs`): separate Shell and Engine roots, the maintenance bootstrap, and the Shell build identity passed to the Engine.

Scripts: `scripts/desktop-release.mjs` writes the test-fault marker only when the caller asks for it (`testFaultHooks`), and refuses otherwise. `scripts/p6-g0-feasibility-probe.mjs` is the feasibility probe from the earlier G0 work.

Tests (`runtime/tests`): ten `p6-g0-*` test files, the support module `p6-g0-support.mjs` (including the env-gated `recordEvidence` writer), and `tiers.json` entries for the heavy tier.

Documents: `docs/reviews/2026-11-01-p6-g0-completion.md` (corrected sections 1, 4, 11, 12, 16, 22, 23 and 25), `docs/adr/0010-p6-trusted-build-activation-rollback.md` (a G0 note in section 7 and a revision row in section 13), and this report.

## 5. C09 native proof

Test file `runtime/tests/p6-g0-c09.test.mjs`, three packaged tests:

- Native hold (`P6-G0 C09: an unproven Engine A tree holds the switch…`). Engine A's real termination runs; the debug-only seam withholds the emptiness proof. The Host records the managed instance as unproven and holds: the operation is `held`, nothing commits, no second Engine launches, the selector still names Engine A, and the process is no longer alive after the real termination. Evidence: `2026-11-01-p6-g0-final-c09-native-hold.json` (operation `412203c4-9d43-4439-af32-95c8e623cba2`, process 30840, `injected: true`).
- Restart proof (`P6-G0 C09 restart…`). A restart without fresh proof holds and launches nothing new. A restart with fresh proof (the seam removed and the recorded processes gone) proves the tree ended, abandons the switch, and restarts Engine A exactly once. A substituted package under the same operation is refused with HTTP 409, and Engine B is never launched. Evidence: `c09-restart-proof.json` (operation `46614523-45cd-4453-9efa-e901cccb82b8`).
- Crash after the fence (`P6-G0 C09 crash…`). The Host exits at the `after_fenced` crash point with code 86; the fence recorded the managed tree. A restart whose proof is withheld holds, names the recorded instance, and launches only the original Engine A. Evidence: `c09-crash-restart.json` (operation `13d80622-d224-4f5d-9e71-8a76b006862b`).

The seam is honoured only by a debug Host. A release configuration refuses it (`validate_config`), and each use also checks `debug_assertions`. The limitation is that the uncertainty is injected after a real termination, not produced by the operating system (section 20, item 1).

## 6. Custody packaged E2E

Test `runtime/tests/p6-g0-custody-e2e.test.mjs`. Engine A launches a Custody Job through its own production Custody client; the Job and a descendant are live.

- B1: a switch with a live Job is refused with HTTP 409 `custody_jobs_active`; the operation is not accepted; Engine B is never launched; the live Job keeps running; the refusal lifts the fence, and a fresh admission is accepted and then withdrawn.
- B3: an admission during the fence window is refused with `custody_fenced`.
- B2: the Job and its descendant end through the Host's own stop; the Host records the tree as ended (`processTreeEnded: true`).
- Committed retry: the same operation is retried with the fence up for a racing admission (refused with `custody_fenced`), then the switch is accepted with HTTP 202, verifies, and commits exactly once. The selector names Engine B under the operation identity.

Evidence: `2026-11-01-p6-g0-final-custody-e2e.json` (operation `21bcacc3-e6eb-4884-8557-dee2ff21ce8c`, Job processes 32888 and 9308, `commits: 1`).

## 7. Internal admission fix

The finding was that Engine-internal Run creation was not admission-gated. The fix is one barrier with three checks, all on the Engine's `switchQuiescence` state:

- `captureRun` refuses before any write (`switch_in_progress`, HTTP 503). It is the only `INSERT INTO runs` in `runtime/core`; the barrier test asserts both facts.
- Public owner routes that could start a Run are refused by the admission gate. Settling routes stay open: Judge decisions, observation acknowledgements, escalation extensions and the stop routes.
- A Judge decision that would admit a Repair Run is refused at commit (`prepareCommit`). The attempt then fails with `switch_in_progress`. This is limitation 7 in section 20.

Work admitted before quiescence keeps settling. The switch waits for it up to 60 s and is refused if it does not settle. The M4 Judge dispatch gate and the continuation gates were removed because they blocked settling work globally, which the specification forbids.

Tests: `p6-g0-admission-barrier.test.mjs` (eight tests, all pass) and `p6-g0-admission.test.mjs` (one test, passes). The barrier summary is `2026-11-01-p6-g0-final-barrier-summary.json`, derived from the TAP log of the frozen run.

## 8. Legacy activation E2E

Test `runtime/tests/p6-g0-legacy-installed.test.mjs`. In a packaged P6 installation, the installed Engine A sends the legacy whole-release activation through its production bridge. The Host refuses it with `p6_legacy_activation_refused` before any staging, stop, selector write, process launch or receipt. The evidence records:

- refusal `ok: false`, code `p6_legacy_activation_refused`, refused by the installed Engine A process;
- the selector is unchanged (`engine-a`, same digest and generation); the installed versions are unchanged;
- launches before and after the refusal: 1 and 1; no Host event was recorded after the refusal;
- the Shell and Host digests are unchanged.

Evidence: `2026-11-01-p6-g0-final-legacy-installed.json`.

The other activation and selection commands were reviewed by reading the dispatch path. The Host refuses `lifecycle.activate_candidate` in any P6 installation. An Engine package is refused on an installation without its Shell, at staging and as the initial build. The G0 engine commands (`engine.stage`, `engine.switch`, `engine.switch_status`, `engine.maintenance_wait`) require a P6 installation and verified state, and no other path writes the selector.

## 9. Recovery matrix reconciliation

Classification used here: **real native fault** (an operating-system fault), **real packaged E2E** (a real packaged process run end to end), **controlled debug-only injection** (a debug-only crash point on a real process, which exits for real), **partial simulation** (a condition modelled, not produced), **source-only reasoning** (verified by reading the code, not by a test).

| Case | Scenario | Classification | Test | Result |
|---|---|---|---|---|
| C01 | Stage intent before the first file | controlled debug-only injection (`after_stage_intent`) | `G0-C01/C02/C03` | PASS |
| C02 | Stage copy partially complete | controlled debug-only injection (`mid_stage_copy`); the partial bytes are real (one of 722 files) | `G0-C01/C02/C03` and `P6-G0 C02 and C13` | PASS (real partial bytes; earlier wording said simulated) |
| C03 | Stage finalized before the stage record | controlled debug-only injection (`after_stage_copy`) | `G0-C01/C02/C03` | PASS |
| C04 | Switch request persisted | controlled debug-only injection (`after_fenced`) | `G0-C04/C10` | PASS |
| C05 | Custody fence begins | shares C04's crash point; the live-Job fence is also exercised end to end | `G0-C04/C10`, `P6-G0 Custody E2E` | PASS |
| C06 | Quiescent but not stopped | shares C04's crash point | `G0-C04/C10` | PASS |
| C07 | Candidate preflight running | controlled debug-only injection (`after_candidate_spawned`) | `G0-C07` | PASS |
| C08 | Candidate preflight fails | real packaged E2E (candidate fails at module load, before its report) | `P6-G0 switch negative` | PASS |
| C09 | Termination uncertain | controlled debug-only injection (the emptiness answer is withheld after the real termination) | `P6-G0 C09` (three tests) | PASS (seam; section 5) |
| C10 | Engine A terminated before the commit | controlled debug-only injection (`after_a_stopped`) | `G0-C04/C10` | PASS |
| C11 | Host exits before the selector commit | controlled debug-only injection (`before_commit_write`) | `G0-C07/C11` | PASS |
| C12 | Host exits after the selector commit | controlled debug-only injection (`after_commit_write`) | `G0-C12/C13/C18` | PASS |
| C13 | Commit succeeds, acknowledgement lost | partial simulation: the lost response is modelled as a Host death after `committed`; the retry is real | `G0-C12/C13/C18`, `P6-G0 C02 and C13` | PASS (retry returns 200, duplicate, committed; no launch, no commit) |
| C14 | Engine B exits during the transition | real packaged E2E (candidate exits after its preflight report, before the decision) | `G0-C14` | PASS |
| C15 | Fallback interrupted | controlled debug-only injection (`before_fallback_start`) with a failing candidate | `G0-C15` | PASS |
| C16 | Production Store changes while the Host is down | controlled debug-only injection (`after_guard`), then a real change to the production file | `G0-C16` | PASS |
| C17 | Concurrent switch requests | real packaged E2E (two real requests): exactly one accepted (202), one refused (409) | `G0-C17` | PASS |
| C18 | Repeated Host restart | controlled debug-only injection (restarts after the committed crash) | `G0-C12/C13/C18` | PASS |

Two reconciliation items are not G0 cases and are recorded here:

- The stage-abandon path (a copy or rename failure after the intent) has no native test. It is verified by source-only reasoning (section 20, item 4).
- The restart arms for unproven holds are covered by C09's restart tests (seam).

## 10. Switch ordering audit

The audit read the switch path in order and checked each ordering constraint against the code and the journal test (`p6-g0-switch.test.mjs`, which asserts the journal order, and the evidence `journalOrder` in `switch.json`).

Order as implemented:

1. Identity and generation checks, and the package digest check, before any write.
2. The Custody fence (`set_fenced`) and the zero-job proof. A refusal lifts the fence.
3. One locked write persists `fenced` with the managed tree recorded. A switch with no managed Engine is refused before the write.
4. The worker waits the grace period, refreshes the tree, and persists the refreshed record before the stop. A tree that is no longer recorded is recorded as unproven and holds.
5. The stop, with a proof that the Job is empty and the child is reaped. Only then is `a_stopped` persisted.
6. The Store guards (share-mode handles on the production files) and the disposable copy. The guard is taken after the stop.
7. The preflight runs on the disposable copy only. Its report is bound to the candidate process.
8. The commit writes the selector once, after `preflight_passed` and the boundary check. `committed` follows, then readiness, then `verified`.
9. Fallback is allowed only before the commit, once per operation.

Journal order recorded in the switch evidence: `engine_staged` (3), `engine_switch_accepted` (4), `engine_preflight_passed` (7), `engine_store_boundary_verified` (8), `engine_switch_committed` (9), `engine_switch_verified` (10).

Audit findings during this work, each fixed and re-checked: the fence snapshot was taken outside the fence's lock (the run loop could reap the tree between snapshot and fence); a switch could record `a_stopped` without a stop that ran (refused now); a failed stage could wedge later switches (abandoned or superseded now). None of the ordering constraints is violated by the current code.

## 11. Handoff correction

The completion report's section 25 named Owner approval flows, package attestation, an update channel and a Host update path as P6-BUILD work, and named the owner route as an interface. That was wrong. The corrected handoff:

- ADR-0010 section 12: no Owner approval after an eligible accepted P5 handoff; no Host update path; no universal updater; no second supervisor; no new lifecycle service or updater daemon (section 6).
- The owner route `POST /api/v4/lifecycle/engine-switch` is a G0 test trigger. It is registered only in test-marked packages. A packaged Engine without the marker answers 404 (evidence `production-trigger`, status 404). It is not an interface P6-BUILD builds on.
- The production trigger is the P5 handoff path that P6-BUILD adds. It calls the Host's switch commands after its own eligibility check.
- ADR-0010 section 7 records a G0 deviation: the pending operation is recorded in the profile's `lifecycle.json`, and `active.json` holds only the committed selection. P6-BUILD must either move the operation into `active.json` or amend section 7 (section 21).

## 12. Source, build and package identities

- Engine builds: `engine-a` (selected at start) and `engine-b` (staged candidate). Shell build: `shell-g0` (`SHELL_BUILD_ID`).
- Package digests, from the final switch evidence (`switch.json`):
  - Engine A package: `be17e22cfbd3ecc90fa45539935a10bde402fb188b68df518e75464adc6caf18`
  - Engine B package: `7e529542eb0bb6672a65c93045ccd4bb117be4585a91c2b387ff5343ba0d5741` (the staged package digest the switch was bound to)
- Engine packages from the separate M1 identity run (`m1-identity.json`): A `f22a70cf00e62cf4c636bff20ffd1fb1004d45e8c508a839361701e1c7c1b73a`, B `89d46e8473b3a1ea35ffed68acd561a13e387eac8029072730cb9e3adadfff74`. Each test builds its own clones, so package digests differ between runs.
- Source commits: each test creates clean clones from a test-owned base repository, whose commit is generated per run and is not recorded in the evidence. The Engine B marker commit differs from Engine A only by the Engine-only marker.
- Build receipts: packages carry `build.json` schema 2 and bind to the Shell through `shell.json` (verified by `verify_engine_binding`).

## 13. Host and Shell digests

From the final evidence files (identical in every record):

- Shell executable (`shell/deszo.exe`), before and after every run: `60cd2526f37c649d444aeeee74f150a62b32fe53d649cac8e2607f1ddbd72dbe`.
- Lifecycle Host executable (the debug Host measured by the tests), before and after every run: `c7015bf60ec67628c29d7ec290507e6588c5a4e282f8334df07468e463287ac2`.

Each record that captures these digests shows them unchanged across the run: `switch`, `failed-b`, `c09-native-hold`, `custody-e2e`, `legacy-installed`, `m1-identity`, `c02-c13`.

## 14. Focused test results

The focused run of the 29 P6-G0 tests on the round-3 code (before the freeze) passed 29 of 29 (`scratchpad/g0-round3-run.log`). The same 29 tests pass in the frozen full regression (section 15). Their names and results are in `2026-11-01-p6-g0-final-p6-g0-suite-summary.json`, derived from the TAP log:

- `P6-G0 barrier` (8), `P6-G0 admission` (1), `P6-G0 C02 and C13` (1), `P6-G0 C09` (3), `P6-G0 Custody E2E` (1), `P6-G0 production bundles` and `P6-G0 raw runtime…` (2), `P6-G0 M1` (1), `P6-G0 legacy bypass` (1), `G0-C04/C10`, `G0-C07`, `G0-C07/C11`, `G0-C12/C13/C18`, `G0-C15`, `G0-C16`, `G0-C14`, `G0-C17`, `G0-C01/C02/C03` (9 recovery tests), `P6-G0 switch` and `P6-G0 switch negative` (2).

Earlier focused runs during this work are recorded in the session's scratchpad logs; each intermediate failure was diagnosed and fixed before the freeze (for example, a Custody environment-block fault and a race in fence admission).

## 15. Full Node regression

Command: `npm test` (`scripts/run-tests.mjs full`), run from Windows PowerShell through `scratchpad/regress-g0-final.cmd`, with the evidence directory set. The Windows PATH resolves `tar` to the system `tar.exe` (bsdtar) and `git` to Git for Windows.

- Node v22.20.0; Windows 11 Home Single Language 10.0.26300; platform `win32 x64`.
- Result: `# tests 995`, `# pass 995`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`. Duration 10,573,728 ms.
- Top-level TAP entries: 964 (node's TAP reporter counts subtests in `# tests`).
- Log: `docs/reviews/evidence/2026-11-01-p6-g0-final-npm-test.tap.log`.
- The runner noted that some test roots could not be removed. They belong to dead test owners from earlier failed runs and are kept as failure diagnostics by design (section 22).

First attempt, recorded for transparency. The first full run was started from Git Bash. In that shell `tar` resolves to GNU tar 1.34 and `git` resolves to a hard-linked command shim. It finished with 995 tests, 984 passing and 11 failing: ten P5 packaged E2E tests failed with `tar: Cannot connect to C: resolve failed` (GNU tar reads `C:` as a host), and `P5 native source identity…` failed because `git` was the shim. None of the 11 failures involved G0 code; the earlier frozen run passed them under a Windows PATH. The first attempt's log was overwritten by the rerun. The results above are from the rerun, from the Windows PATH, on the same frozen snapshot.

## 16. Full Rust regression

Command: `cargo test --manifest-path lifecycle-host/Cargo.toml` (cargo 1.97.1, rustc 1.97.1).

- Result: 46 passed, 0 failed, 0 ignored; the test binary reports no warnings.
- Log: `docs/reviews/evidence/2026-11-01-p6-g0-final-cargo-test.log`.
- The earlier frozen count was 45; the added test is the environment-block test in `custody.rs`.

## 17. Packaged desktop E2E

The packaged tests in the frozen full run, all passing:

- The P6-G0 packaged tests: the C09 native tests (three), the Custody E2E, the legacy installed bridge, the packaged switch and failed-candidate tests, the C02/C13 mid-copy test, the M1 identity test (which also checks the production 404), the nine recovery tests, and the two fault-hook tests that check production bundles and packages.
- The packaged P5 self-repair E2E tests (P5-E2E1, P5-FINAL, P5-CLOSURE, and P5 native source identity). They fail in the Git Bash attempt only (section 15) and pass in the frozen run.
- The desktop build-receipt test (`desktop release provenance binds the compiled shell, runtime manifest, build identity, and production fault-hook mode`).

## 18. Independent review findings

Five checks, by read-only reviewers. Checks 1 and 2 were made by two separate fresh-context reviewers (both Opus). Checks 3 to 5 were made by resuming the second reviewer through its own transcript, so those three were not fresh-context reviews.

Check 1 (fresh reviewer, initial implementation review). Findings:

- F1 (Medium): a restart could relaunch Engine A after an unproven termination was recorded. Fixed: one durable write for the record and the hold; restart arms prove the recorded instance before any start.
- F2 (Medium): an Engine package on an installation without a Shell was accepted and then panicked. Fixed: refused at staging and as the initial build, before any write; `expect` calls became errors.
- F3 (Medium): quiescing blocked work that had already been admitted, and the owner stop routes were refused. Fixed: settling routes are exempt; the Judge dispatch and continuation gates were removed.
- F4 (Medium, contract): an owner-triggered switch route existed in production. Fixed: the route exists only in test-marked packages; a production package answers 404.
- F5 (Low): the handoff documentation was wrong. Fixed: completion report section 25 and ADR section 7 and 13 corrected; the final report states the handoff (section 21).
- F6 (Low): the Host could stay up with an unfinished operation. Fixed: exit detection uses in-flight phases only.
- F7 (Low): after a restart, the zero-job check ignores Custody jobs whose end is unknown. Accepted as a limitation (section 20, item 8).

Check 2 (fresh re-review of the F fixes). All F1 to F6 closed; F5 partly open. New findings:

- N1 (Medium, documentation): completion report section 11 and section 25 invariant 6 described the old restart rules. Fixed: section 11 rewritten to match the code.
- N2 (Low): a failed stage could leave the operation in `staging`, which blocked the Host's exit and, with no abandon path, wedged later switches. Fixed: `staging` is not in-flight; a failed stage after its intent is abandoned.
- N3 (Low): the fence recorded only the root process; a restart mid-stop could start A before members were proven gone. Fixed: the fence records the Job's members; restart proves them all; a proven-stopped phase is not re-checked.
- N4 (Low): the owner stop routes were refused during quiescence. Fixed: exempt as settling routes.
- N5 (Low): an Engine initial build could be saved on an installation without a Shell. Fixed: refused before any write.

Check 3 (check of the N fixes). No High or Medium. N4 and N5 closed. N2 and N3 closed for their targets, with Lows: an operation identity could still wedge other identities (fixed by supersession), the fence snapshot could miss processes started after it (fixed by the post-grace refresh), and a missing managed Engine could still allow a recorded stop (fixed in check 4). Documentation gaps were fixed.

Check 4 (check of the supersession, fence-lock and refresh changes). No High or Medium. Closed: supersession, lock discipline and abandon cleanup. Lows, all fixed: a hold with no termination record could never clear at restart (now written with the hold in one durable write); a race could record `a_stopped` without a stop that ran (the switch path now refuses a stop with no managed Engine); and the superseded side effects ran before the stage's own checks (now after the intent write).

Check 5 (check of the check-4 fixes). All six items closed. No High or Medium. One new Low: if the Host dies between a superseding stage's intent and its cleanup, one incoming directory can remain (limitation 9). Two documentation nits fixed.

Notes on the process. No check found a High finding. Each check's findings are closed in code or recorded as limitations; the disposition of every Low is in section 19 and section 20.

## 19. Remediation and re-review

Each finding above was fixed in code or in documentation, then checked by the reviewer against the changed code. Two decisions are recorded here because they change behaviour that an earlier test asserted:

- Supersession. A new stage supersedes a staged or interrupted stage that never switched. The earlier test asserted that a second operation was refused while the first was staged. That assertion encoded the wedge that check 3 found, so the test was changed to assert supersession, and to assert that a different package under the installed identity is an identity conflict whichever operation asks.
- Settling routes. Judge decisions, observation acknowledgements, escalation extensions and the stop routes are exempt from the admission gate. The reason is that they settle admitted work. Each of them either creates no Run or, if it creates one, reaches `captureRun`, which refuses it.

The rebuilt Host passed its 46 unit tests after every round. The packaged set was run in full on the final code (29 of 29, section 14). Runs begun after earlier rounds were stopped before completion, because each later change superseded them. The full regression ran once, on the frozen snapshot (section 15).

## 20. Remaining accepted limitations

1. G0-C09 is exercised through a debug-only seam that withholds the emptiness proof after a real termination. No operating-system-produced uncertain termination of a real process tree was tested. The seam is absent from release builds.
2. The production switch trigger does not exist in G0. A production package answers 404 on the switch route. P6-BUILD must add the P5-handoff trigger before the switch can run in production.
3. The Shell's own window path (close and start behaviour during a maintenance candidate, and its 20-minute wait) is not probed. The installed Engine's bridge is probed.
4. The stage-abandon path (a copy or rename failure after the intent) has no native test. It is verified by source reading only, because no injection seam exists for those failures.
5. A hold that needs proof is cleared only by a restart that proves the recorded tree. There is no operator command in G0. If the recorded instance is still alive at restart, the switch holds until it ends. A creation time that cannot be read is never proof, so its hold persists (fail closed).
6. Processes a tree starts during the stop, after the post-grace refresh, are covered only by kill-on-close if the Host dies mid-stop.
7. A Judge repair decision in flight at quiescence is refused at commit; its attempt fails with `switch_in_progress`. A switch whose work does not settle within 60 s is refused, and the Engine admits again.
8. After a Host restart, Custody jobs whose end is unknown are not counted in the zero-job check. This relies on kill-on-close, which ends the tree when its Host dies. Counting them would refuse every later switch.
9. If the Host dies between a superseding stage's intent and its cleanup, one `.incoming-<superseded operation>` directory can remain, and the `engine_stage_superseded` event is not written. This is disk residue with no effect on any switch or selection.
10. The pending operation is recorded in the profile's `lifecycle.json`, not in `active.json` as ADR section 7 specifies. The G0 evidence covers this form only.
11. The candidate writes its runner log into the profile before the commit.
12. The G0 tests run on Windows against a debug Host. Release-Host timing was not tested.
13. Store guards and Custody depend on Windows share modes and Job Objects.
14. The publication POST timeout and the product's own client timeouts for it were not checked beyond the P5 harness.
15. Test-root retention: 27 roots from 18 dead owners remain from earlier failed runs. They are failure diagnostics kept by design and are not removed by this report.

## 21. Exact P6-BUILD interface and handoff

Interface the Host provides (lifecycle bridge allow-list):

- `engine.stage` (intent, then copy, digest check, install, verify; never touches the selector).
- `engine.switch` (identity-checked; fences Custody; persists `fenced` with the managed tree; the worker performs the stop, guards, preflight, commit and readiness).
- `engine.switch_status` (read-only status of an operation).
- `engine.maintenance_wait` (the candidate's decision: `commit` only after the selector write and the guard release).
- Custody commands on the lifecycle capability.
- Journal events `engine_staged`, `engine_switch_accepted`, `engine_preflight_passed`, `engine_store_boundary_verified`, `engine_switch_committed`, `engine_switch_verified`, `engine_switch_held`, `engine_stage_abandoned`, `engine_stage_superseded`, `managed_process_termination_unproven`, `engine_termination_proven`.
- Refused in any P6 installation: `lifecycle.activate_candidate` (`p6_legacy_activation_refused`).

Trigger P6-BUILD must provide:

- A production trigger that is reached only through an accepted P5 handoff with an eligibility check and the exact candidate identity and digest. It must call the Host's stage and switch commands in that order, with the same operation identity, and must not add an Owner approval, a new API or an approval flow.
- The trigger may run only on a P6 installation (`shell/shell.json` present), for an Engine package bound to that Shell.

Invariants P6-BUILD must keep (completion report section 25, now corrected):

1. `active.json` is the selector. Staging never writes it. (ADR section 7 deviation: see section 11 and limitation 10.)
2. A switch commits only after the candidate's preflight reports on the disposable copy, with identities the Host has checked.
3. The live Store is never preflighted, never restored from a snapshot, and never used for a fallback without the guard proof.
4. Fallback to the previous Engine is allowed only before the commit, once per operation, with the production set proven unchanged.
5. `lifecycle.activate_candidate` stays refused in P6 installations.
6. Restart reconciliation follows completion report section 11, including the M5 exception and the fresh-proof rule for held operations.

Forbidden by ADR-0010 and by this report: an Owner approval after an eligible accepted P5 handoff; a Host update path; a universal updater; a second supervisor; a new lifecycle service or updater daemon.

Open items P6-BUILD must resolve before it relies on G0: the production trigger (above); the location of the pending operation (ADR section 7); an operator path for holds that a restart cannot clear (limitation 5); the supersession rule for stages (section 19); and a native test of the stage-abandon path (limitation 4).

## 22. Final repository and snapshot state

- Branch `codex/adr-0003-0005-completion`; HEAD `1f54c47fe265c6b47bf36695be56214056fc3af1`; no commit or push was made.
- Working tree: 73 entries in `git status --short` (59 at the freeze plus 14 new evidence files). Log files are gitignored.
- Frozen snapshot: `7bcb4e992f2772ff7effafb92b36cee8bbd4771a43097b7f7016e86b16701410`, 796 files. Identical before and after the regression.
- Evidence directory `docs/reviews/evidence/`, files written by this acceptance run:
  - Records: `2026-11-01-p6-g0-final-switch.json`, `…-failed-b.json`, `…-c09-native-hold.json`, `…-c09-restart-proof.json`, `…-c09-crash-restart.json`, `…-custody-e2e.json`, `…-legacy-installed.json`, `…-c02-c13.json`, `…-m1-identity.json`, `…-production-trigger.json`.
  - Summaries derived from the TAP log: `…-barrier-summary.json`, `…-p6-g0-suite-summary.json`.
  - Logs and environment: `…-npm-test.tap.log`, `…-cargo-test.log`, `…-test-tiers.log`, `…-docs-check.log`, `…-build.log`, `…-diff-check.log`, `…-environment.txt`, `…-regression-summary.txt`.
- Regression results: Node 995 of 995 (section 15); Rust 46 of 46 (section 16); tier check: 100 files, quick 56, integration 34, heavy 10, no problems; docs check: no errors; build: built; whitespace check: no whitespace errors (line-ending warnings only).
- No Deszo process from this repository was running after the regression.
- Retained test roots: 27, from 18 dead owners (failure diagnostics from earlier failed runs). They are kept, not removed.
- The Deszo Control Host services, the Codex node processes and the site's development server were not touched.
