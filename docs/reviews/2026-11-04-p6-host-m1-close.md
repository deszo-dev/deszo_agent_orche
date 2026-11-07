# P6-HOST-M1-CLOSE: Native Commit/Shutdown Ordering in the Switch Worker

**Project:** Deszo Agent Orchestrator
**Stage:** P6-FINAL-CLOSURE, Part I (P6-HOST-M1-CLOSE)
**Date:** 2026-11-04
**Gate:** `P6-HOST-M1-CLOSE VERIFIED` (residuals in §11)

## 1. Disposition

M1 is closed. The race was reproduced deterministically on the unfixed Host. The fix puts the commit decision and the single selector write in one critical section that shares the state lock with the Host's shutdown request. The four M1 regression scenarios, the existing G0 switch, recovery, C09 and crash-point tests (19 tests), and the Rust Host unit suite (47 tests) pass on the fixed Host. The independent Host review ended with no Critical, High or contract-breaking Medium finding. Residual items are in §11.

This is a narrowly scoped native Host change. Per the Stage I brief, it reaches users only through a normal maintainer Host release, never through P6 self-installation.

## 2. The original failure (M1)

The M1 finding is recorded as open and non-blocking in `docs/reviews/2026-11-03-p6-build-unblock.md` §23. There, candidate liveness (`engine_switch.rs:738-759` at that time) was checked before the 15–19 s package re-verification. Neither liveness nor a pending Host stop was re-checked before the commit, and the stdin `shutdown` line did not coordinate with the switch worker. A candidate exit or Host stop inside that window committed B without the pre-commit fallback. Store safety was preserved, and restart started the committed B.

The §23 recommended fix was to re-check the managed record's liveness and a stop flag under the state lock immediately before the commit, and to have the shutdown set the flag. The fix in §5 implements that recommendation, with the additions the review rounds required (spawn gate, managed-stop serialization, and outcome handling).

## 3. Reproduction

Test file: `runtime/tests/p6-g0-m1-commit-order.test.mjs`. A debug-only barrier (`test_switch_barrier_dir`, `barrier()` in `lifecycle-host/src/engine_switch.rs`) parks the switch worker at named points. The shutdown or the candidate's death is sequenced against the worker's position, and the scenarios use no sleep to order events.

Result on the unfixed Host (`docs/reviews/evidence/2026-11-04-p6-host-m1-reproduction-unfixed.tap.log`, `# tests 3`, `# pass 1`, `# fail 2`):

| Scenario | Unfixed Host | Failing assertion |
| --- | --- | --- |
| M1-A: shutdown accepted before the commit | **not ok** | "the candidate was not committed after the shutdown" (expected 0 commits, actual 1) |
| M1-B: candidate exits before the commit | **not ok** | "a candidate that died before the commit is never committed" (expected 0 commits, actual 1) |
| M1-C: commit wins before the shutdown | ok | — (guard case) |

The unfixed run used the same test file and the same debug barrier seam, executed before the M1 ordering edits in §5 were applied. The M1-A and M1-B failures show the commit landing after an accepted shutdown and on a known-dead candidate, which is the window described in §2.

### 3.1 Native process timeline (M1-A and M1-B)

The timeline below is the order the test enforces through the barrier and the Host's stdin, with the durable phase the worker holds at each step. The test asserts the same order through `host_shutdown_requested`, `application_spawned`, and `engine_switch_committed` events in the Host journal.

| Step | M1-A (shutdown before commit) | M1-B (candidate dies before commit) |
| --- | --- | --- |
| 1 | Engine A serves; the switch request returns 202. A is stopped under Custody (`a_stopped`), B is staged and spawned for preflight. | Same. |
| 2 | B passes preflight; the worker verifies the B package and parks at `pre_commit`. B is the managed candidate, alive. | Same; the worker parks at `pre_commit` with B alive. |
| 3 | The test writes `shutdown` to Host stdin. The Host sets `shutdown_requested` under the state lock and journals `host_shutdown_requested`. | The test kills B's application PID and waits for it to exit. The Host's managed record for B is now not running. |
| 4 | The test releases `pre_commit`. The commit section observes the flag and returns `ShutdownWon`. No selector is written. | The test releases `pre_commit`. The commit section observes the exited record and returns `CandidateNotRunning`. No selector is written. |
| 5 | The worker returns without a fallback; the Store guard is released; the phase stays pre-commit. The Host's shutdown stops B's tree under `managed_stop`. | The worker runs the pre-commit fallback once and restores A (`rolled_back`). |
| 6 | The Host exits. `active.json` still names A. No `engine_switch_committed` event exists. | The selector still names A. No `engine_switch_committed` event exists. |
| 7 | Restart reconciles the stored pre-commit phase to `rolled_back` and starts A once. | Not applicable; the fallback already completed. |

M1-C (commit before shutdown) follows the same sequence through step 2. At `post_commit`, the selector already names B and `engine_switch_committed` exists. The shutdown then stops B as a postcommit stop, and restart starts B only (§8).

## 4. Root cause

The commit decision (candidate alive, no shutdown) and the selector write did not share a synchronization boundary with the Host's shutdown. The shutdown took the managed record under the state lock, but the worker's liveness check happened earlier and outside that lock, and the commit did not re-check either condition.

## 5. Minimal fix

All changes are in `lifecycle-host/src/`:

- **Shutdown request under the state lock.** `RuntimeState.shutdown_requested` and `request_host_shutdown()` (`lib.rs`) set the flag under the state lock that also guards the managed record. The graceful stop, the unexpected-exit path and `Drop` call it before `shutdown_managed`. A journal failure does not skip the shutdown (`let _ =`).
- **One commit critical section** (`engine_switch.rs`, `commit`). Under the state lock: refuse with `ShutdownWon` if the flag is set; refuse with `CandidateNotRunning` unless the managed record exists, has not exited (`try_wait`), and matches the candidate's build and generation. Otherwise persist `COMMITTING`, write `active.json` atomically, update the durable selection, set custody's generation and fence, and persist `COMMITTED`. A custody fence error is logged and does not hold a switch whose selector is already written.
- **Outcome mapping** (`drive_switch`). `Committed` continues to readiness. `ShutdownWon` returns without a fallback. `CandidateNotRunning` takes the existing pre-commit fallback.
- **No fallback during a Host stop** (`fallback_to_a`). A stopping Host does not restart the previous Engine during its shutdown. The operation is left in its recorded pre-commit phase, and the next start completes the rollback once (§8).
- **Stopped pre-commit switches are not held** (`run_switch`). A switch the Host's shutdown stopped before its commit (phases `FENCED`, `A_STOPPED`, `GUARDED`, `PREFLIGHT_RUNNING`, `PREFLIGHT_PASSED`, `FALLBACK`) releases the Store guard, and restart reconciles it. A failure after the commit keeps its record beside `COMMITTED`, as before.
- **No spawn after a shutdown request** (`spawn_build_with`). The spawn check and the recording of the new process happen under the same lock.
- **One managed-tree stop at a time** (`managed_stop` mutex in `Shared`, taken by `shutdown_managed_inner`). A Host stop cannot return while a switch is still stopping the previous Engine's tree.
- **Readiness counts only for a running candidate** (`wait_for_candidate_ready`). Readiness from a candidate that has exited, or whose managed record is gone, is an error.

Store boundary, Custody fencing, process-termination proof, package verification, the atomic selector commit, pre-commit fallback and restart reconciliation keep their semantics. The change adds no second selector, no second switch state machine, and no global lock held during package hashing.

## 6. Commit/shutdown ordering

Both the shutdown request (`F`) and the commit decision (`C`) take `shared.state`:

- If `F` precedes `C`, `C` observes the flag and writes nothing (`ShutdownWon`). The candidate is not committed, and `active.json` still names A.
- If `C` precedes `F`, the selector names B and `COMMITTED` is persisted. The shutdown's later take of the managed record stops B as a postcommit stop. Restart reconciles B as the committed Engine (M1-C). No rollback runs.
- Spawns after `F` are refused under the same lock, so no candidate and no fallback Engine starts after a shutdown request.

The `shutdown_requested` flag is never cleared. It exists only in the running Host, so a restarted Host starts unflagged and decides the operation from the durable phase and the selector.

## 7. Candidate-exit handling

- **Before the commit section:** the candidate's death is read under the state lock inside the commit section and refuses the commit (`CandidateNotRunning`), with the pre-commit fallback (M1-B).
- **Between the commit section and readiness:** no instantaneous check can prevent a postcommit exit, and this change does not claim one. The exit is classified as postcommit: the operation stays `COMMITTED` with a failure record, no automatic rollback runs, and restart starts the committed Engine (existing G0 rule; M1-C and G0-C12/C13/C18).
- **Readiness:** `wait_for_candidate_ready` succeeds only for a running candidate.

## 8. Recovery behavior

Restart reconciliation is `reconcile_at_start` (`engine_switch.rs`). For the phases the M1 fix touches:

- `FENCED`: if the previous Engine's tree is proven ended, the operation is abandoned and the committed Engine restarts. If not, the switch holds with an unproven-termination record (C09).
- `A_STOPPED`: abandoned; the committed Engine restarts. The Host records `A_STOPPED` only after the tree was proven ended in that session.
- `GUARDED`, `PREFLIGHT_RUNNING`, `PREFLIGHT_PASSED`, and `COMMITTING` without a selector naming this operation: if the production Store evidence still matches and no fallback was attempted, the operation becomes `ROLLED_BACK` and the committed Engine (A) restarts. Otherwise the switch holds.
- `COMMITTING` or `COMMITTED` with a selector naming this operation: the operation becomes `COMMITTED` and the candidate's readiness completes it. Otherwise the switch holds.
- `FALLBACK`: `ROLLED_BACK`; the committed Engine restarts.
- `HELD`: resumes only on fresh proof for a recorded unproven termination (C09), or when the hold followed a stopped A and no candidate ever ran.

The G0 crash-point tests for these phases pass on the fixed Host: C04/C10 (after the fence or after A stopped), C07 (candidate preflight), C07/C11 (after the preflight report, before the commit), C12/C13/C18 (after the commit), C14, C15 (fallback), C16 (Store changed while down), and C17 (concurrent requests).

## 9. Native and Rust test results

| Suite | Scope | Result | Evidence |
| --- | --- | --- | --- |
| P6-G0 native set (19 tests) | Test IDs in the log: P6-G0 C02/C13 (2 tests), C09 (2 tests), M1-A to M1-D, G0-C04/C10, C07, C07/C11, C12/C13/C18, C15, C14, C16, C17, C01/C02/C03, switch and switch negative. The tests come from the five P6-G0 files (`p6-g0-c02-c13`, `p6-g0-c09`, `p6-g0-m1-commit-order`, `p6-g0-recovery`, `p6-g0-switch`). | **19 pass, 0 fail, 0 cancelled, 0 skipped**; 1293.5 s | `docs/reviews/evidence/2026-11-04-p6-host-m1-final-native.tap.log` |
| Unfixed-Host reproduction | `p6-g0-m1-commit-order.test.mjs` (3 tests) | M1-A not ok, M1-B not ok, M1-C ok (1 pass, 2 fail); 498.9 s | `docs/reviews/evidence/2026-11-04-p6-host-m1-reproduction-unfixed.tap.log` |
| Rust Host unit suite | `cargo test --manifest-path lifecycle-host/Cargo.toml` | Library: **47 passed, 0 failed**. Binary and doc-tests: 0 tests each. | `docs/reviews/evidence/2026-11-04-p6-host-m1-final-cargo-test.log` |

The PowerShell wrapper printed True/False rather than a numeric exit code. The TAP and cargo summaries are the authoritative results. An earlier run of the same native and cargo suites is kept as `2026-11-04-p6-host-m1-native-m1-g0.tap.log` and `2026-11-04-p6-host-m1-cargo-test.log`; the finals above supersede them.

## 10. Independent Host review

| Round | Result | Disposition |
| --- | --- | --- |
| 1 (fresh-context, read-only) | Nine findings. F1 (High): spawn not gated after a shutdown request. Others: a stopped switch's Store guard outlived the switch (F2); a Host stop could return while the worker still stopped the previous Engine's tree (F3); custody was updated after `COMMITTED` was already visible (F4); readiness liveness (F6); a `?` on the shutdown request could skip the shutdown (F7). F5, F8 and F9 were accepted (§11). | F1–F4, F6 and F7 fixed as in §5 (spawn gate and `managed_stop`; custody moved inside the commit section; `wait_for_candidate_ready`; `let _ =`). The spawn gate has its own test (M1-D). |
| 2 (re-review of the fixes) | NEW-1: `FALLBACK` was missing from the stopped-by-shutdown phase set, so a stopped fallback would be held. NEW-2: a custody unfence error after the selector write left the switch in `COMMITTING`. | NEW-1: `PHASE_FALLBACK` added to the set. NEW-2: the error is logged and `COMMITTED` is still persisted. |
| 3 (focused on the two final hunks) | APPROVE. No Critical, High or contract-breaking Medium finding. | — |

## 11. Residuals (accepted; none blocks the M1 gate)

1. **F5, postcommit readiness failure.** A failed readiness after the commit holds the Host until restart. This is pre-existing G0 behavior, and the switch stays `COMMITTED` or `HELD` (in-flight phases), so the run loop does not relaunch it. Restart reconciles it. Owner: Host maintainer.
2. **Shutdown with no managed record but a set `state.unproven`.** `shutdown_managed_inner` returns Ok. This sits in the pre-existing C09 domain. Severity: Low. Owner: Host maintainer.
3. **`mark_verified` re-lock gap.** A stop between readiness and `mark_verified` can still record `VERIFIED`. Benign, because readiness was observed first.
4. **Defensive `?` after the selector write.** The durable `COMMITTING → COMMITTED` assignment under the held lock is unreachable as an error path. Recorded for later cleanup.
5. **Comment inaccuracy** near `engine_switch.rs` lines 586–587. Documentation only.
6. **F9, run-loop TOCTOU** between the relaunch decision and a switch start. Pre-existing and outside the M1 ordering scope. Owner: Host maintainer.
7. **F8, duplicate verification cost.** The package digest is verified outside the lock and again at commit. This was kept deliberately, to keep the commit check authoritative.
8. **Spontaneous postcommit exit.** No liveness check can prevent a candidate exit after the commit. It is classified as postcommit (§7).

## 12. Final disposition

`P6-HOST-M1-CLOSE VERIFIED`, with residuals 1–8 recorded in §11. The race is reproduced, fixed in one critical section, covered by deterministic native regressions for each ordering, and reviewed independently to a clean final round.
