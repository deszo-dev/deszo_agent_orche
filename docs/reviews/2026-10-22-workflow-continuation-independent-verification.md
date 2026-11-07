# Independent verification: autonomous workflow continuation after an Engine restart

Date: 2026-10-22  
Subject: the claim in [the previous verification report](2026-10-22-workflow-continuation-verification.md) that Suspend → Repair → Restart → Resume passes (CONT-01 to CONT-12)  
Evidence: [workflow-continuation-strict.test.mjs](../../runtime/tests/workflow-continuation-strict.test.mjs) (new), [workflow-continuation.test.mjs](../../runtime/tests/workflow-continuation.test.mjs) (previous; relabelled), and the production sources cited below  
**Verdict: PARTIAL.** Durable state, reuse of committed outputs and safe handling of interrupted work are real. However, after a real OS process restart, the production Engine performs **none** of the continuation transitions. It does not resume the repair, does not detect the repair's completion, does not unblock the parent and does not schedule the parent's next node. The previous `PASS` was not justified: every post-restart workflow step in that test was created by the test harness.

## A. Audit of the previous test

The previous test is `runtime/tests/workflow-continuation.test.mjs`, first test, before this change. It is accounted transition by transition below. "Origin" is who actually caused the transition.

| Step | Source | Origin | What it proves versus what it simulates |
| --- | --- | --- | --- |
| Parent "Phase A" run (`mode: 'branch'`, targets `developer`) | lines 192–204 | TEST_HARNESS → ENGINE executes | It runs only the Developer, and the run then **succeeds**. The parent is never paused or unfinished; it is a completed one-node run |
| "Suspend checkpoint" | 221–247 | TEST_HARNESS | Creates a **test-only** table `workflow_continuations` in the production store and inserts a row. `repairRunId` is a random UUID that no run ever uses. Nothing in production reads this table |
| Repair Developer run | 256–266 | TEST_HARNESS → ENGINE | An ordinary `branch` run in another workspace, with no link to the parent |
| Repair Watcher run | 269–279 | TEST_HARNESS → ENGINE | A separate harness-created `mode: 'node'` run, reusing the Developer output |
| Judge-only lifecycle authorization (CONT-09) | 282–317 | TEST_HARNESS | `authorizeLifecycleProposal` is a function **defined inside the test**. No production code implements `application.activate_candidate` or a role check for it (`grep` over `runtime/core`, `runtime/host`: none). This proves nothing about production |
| Lifecycle intent | 320–344 | TEST_HARNESS | Creates a **test-only** table `lifecycle_operations` and inserts the intent |
| Engine 1 stop and Engine 2 start | 350–358 | HOST_HARNESS | Real; PIDs differ |
| Lifecycle receipt | 371–374 | TEST_HARNESS | A direct SQLite `UPDATE` to `verified` |
| Repair Judge after the restart (CONT-05) | 381–396 | TEST_HARNESS → ENGINE | The **harness** posts a new `mode: 'node'` run for `judge`. The Engine executes it and reuses the Watcher. Nothing about the restart caused this run |
| "Repair completed, unblock parent" (CONT-06) | 399–401 | TEST_HARNESS | A direct SQLite `UPDATE workflow_continuations SET state = 'repair_completed'` |
| Parent Watcher and Judge (CONT-07) | 407–437 | TEST_HARNESS → ENGINE | The **harness** posts two new `mode: 'node'` runs. The Engine reuses the earlier Developer and Watcher outputs by fingerprint |

The earlier `PASS` therefore covered these, all of them real:

- committed outputs persist across a real restart (`attempts`, `artifacts`);
- `reuseSource()` reuses them by fingerprint in a **new** run that someone else creates;
- a hard-killed attempt becomes `interrupted` and is not reusable.

It did not cover:

- any autonomous recovery;
- any parent/repair linkage known to production;
- any Engine-initiated scheduling;
- any production Judge-only lifecycle authorization.

## B. Actual execution trace (strict test)

The strict test runs one scenario.

- **Phase 1.** The parent's Developer succeeds. The Watcher (fixture `fail-once`) fails, and the production lifecycle moves the parent `running → draining → waiting_for_user`.
- **Phase 2.** The repair runs Developer → Watcher; its Judge (fixture `slow-30`) is in flight when Engine A stops, with a workspace file written mid-flight.
- **Restart and observation.** Engine A is stopped through the runner's `shutdown` command, and Engine B starts on the same profile. **After Engine B starts, the harness only observes:** it polls `GET /api/v2/runs` and the run snapshots for 8 s, and reads SQLite read-only. Its only mutation-shaped call is one recovery probe after observation, which the Engine refuses.

Run 1 of 2, from a fresh profile:

| Time (UTC) | Origin | Transition | Identity / evidence |
| --- | --- | --- | --- |
| 16:46:40.234 | TEST_HARNESS | Engine A started | PID 12452 |
| 16:46:40.896 | TEST_HARNESS | Parent run requested (`mode: workflow`) | `88cdacd8…` |
| 16:46:41.467 | ENGINE | Parent Developer `succeeded`; Watcher `failed` ("Simulated transient failure."); run `waiting_for_user` | Production pause path (`engine.mjs` lifecycle table, lines 62–64) |
| 16:46:41.570 | TEST_HARNESS | Repair run requested in workspace `main-repair` | `4243c45d…`. **No production field links it to the parent** |
| 16:46:42.098 | ENGINE | Repair Developer and Watcher `succeeded`; Judge `running` ("CLI process launched.") | Judge has an invocation artifact |
| 16:46:42.099 | TEST_HARNESS | In-flight workspace effect written (`partial-repair.tmp`) | Unknown-outcome effect |
| 16:46:42.446 | HOST_HARNESS | Engine A stopped (runner `shutdown`) | PID 12452 gone |
| (inside the shutdown) | ENGINE | Repair Judge → `canceled`, reason **"Stopped by the user."** | `Engine.shutdown()` sets `stopRequested` without a `stopReason` ([engine.mjs:2254](../../runtime/core/engine.mjs); exit handling at 1888–1890) |
| 16:46:43.140 | HOST_HARNESS | Engine B started | PID 23644 (≠ 12452) |
| (Engine B startup) | ENGINE | `recover()`: parent `waiting_for_user → interrupted`; its unstarted Judge and Result `canceled` ("Runtime restarted before the attempt started."); repair `running → interrupted`; its Result `canceled` | [engine.mjs:158–194](../../runtime/core/engine.mjs) |
| 16:46:43 – 16:46:51 | (none) | **No new run, no attempt, no provider invocation** | Runs 2 → 2; invocation-bearing attempts 5 → 5 |
| 16:46:51.352 | TEST_HARNESS | Recovery probe on parent: **409** "Recovery needs a run that is waiting for the user (state is interrupted)." | [engine.mjs:2145](../../runtime/core/engine.mjs) |
| Final | — | Parent `interrupted`; repair `interrupted`; neither completed | — |

Run 2, a second fresh profile, is identical in structure: PIDs 15296 → 29776, parent `c8ef1801…`, repair `678c75bf…`, runs 2 → 2, invocations 5 → 5, the same 409, and the same `canceled`/"Stopped by the user." for the in-flight Judge.

## C. Capability matrix

| Capability | Production implementation | Test evidence | Verdict |
| --- | --- | --- | --- |
| Durable parent suspension | `waiting_for_user` is reachable and persisted, but `recover()` converts every `waiting_for_user` run to `interrupted` on startup (`ACTIVE_SQL`, engine.mjs:158–186) | Strict test: parent paused, then `interrupted` after restart | PARTIAL: durable within one process only |
| Durable repair linkage | None. No column in `runs` and no production table relates a parent to a repair run (strict test checks `PRAGMA table_info(runs)` and `sqlite_master`) | Strict test assertion; the previous test used a test-only table | NOT_IMPLEMENTED |
| Recovery after process restart | `recover()` reconciles processes, interrupts active attempts and runs, clears locks; persisted runs, attempts and artifacts survive | Strict test, two runs | VERIFIED (state reconciliation, not continuation) |
| Autonomous repair continuation | None. Runs are created only by `createRun` (engine.mjs:810) and run-request decisions (886), both driven by an API caller | Strict test: no new run in 8 s | NOT_IMPLEMENTED |
| Autonomous repair completion | None | Strict test: repair stays `interrupted` | NOT_IMPLEMENTED |
| Automatic parent unblocking | None. `recoverRun` requires `waiting_for_user` **and** an in-memory `this.runs` entry (engine.mjs:2144–2145), neither of which exists after restart | Strict test: 409 | NOT_IMPLEMENTED |
| Automatic parent scheduling | None | Strict test: no parent run created | NOT_IMPLEMENTED |
| Completed-node non-repetition | `reuseSource()` reuses fingerprint-matched `DONE_OK` outputs from the 50 most recent runs of the same workflow and workspace, but only for immediate predecessors in `mode: 'node'` (engine.mjs:960–1006) | Previous test: harness-created `node` runs reuse outputs; strict test: no re-invocation after restart | VERIFIED for reuse in a new caller-created run; NOT_TESTED for autonomous continuation, because none exists |
| Unknown-outcome operation handling | A hard kill gives `interrupted` (previous test 2). A graceful shutdown gives `canceled` with the reason "Stopped by the user." Neither is `succeeded` or reusable | Previous test 2 and the strict test | PARTIAL: safe, but a graceful shutdown misattributes the cause as a user Stop |
| Judge-only lifecycle authorization | No production code. The previous test's check is a test-local function | — | NOT_IMPLEMENTED (previously reported as tested) |

## D. Reassessment of CONT-01 to CONT-12

| Invariant | Previous | Reassessed | Reason |
| --- | --- | --- | --- |
| CONT-01 durable parent suspension | PASS | **PARTIAL** | The previous "parent" never paused: its branch run succeeded, and the "suspension" was a test-table row. The strict test shows a real `waiting_for_user` pause, which a restart converts to `interrupted` |
| CONT-02 linked repair created and executed | PASS | **PARTIAL** | A repair run executes, but it is created by the harness and is not linked in production |
| CONT-03 linkage survives restart | PASS | **FAIL (false positive)** | Only the test-created `workflow_continuations` row survived. No production linkage exists to survive |
| CONT-04 restart keeps durable state | PASS | PASS | Confirmed by the strict test |
| CONT-05 repair resumes after restart | PASS | **NOT_IMPLEMENTED** | The harness posted the repair Judge run. Under observation only, the repair stays `interrupted` |
| CONT-06 repair completion enables the parent | PASS | **NOT_IMPLEMENTED** | Done by a direct SQLite `UPDATE` in the test |
| CONT-07 completed operations not repeated | PASS | **PARTIAL** | True for harness-created `node` runs (reuse works). No autonomous continuation exists in which to verify it |
| CONT-08 unknown outcomes not blindly repeated | PASS | PASS, with a finding | A hard kill gives `interrupted`, not reusable. A graceful shutdown gives `canceled` with the user-Stop reason (see E.3) |
| CONT-09 Judge-only lifecycle proposal | PASS | **NOT_IMPLEMENTED (false positive)** | It tested a function defined in the test file |
| CONT-10 no external response needed | PASS | **NOT_TESTED** | Continuation required external API calls (the harness) at every step |
| CONT-11 no paid provider | PASS | PASS | Fixture CLIs only |
| CONT-12 isolated test data | PASS | PASS | Temporary roots under `.deszo/tests` |

## E. Minimum remaining implementation gap

The smallest production contract that would make the strict `todo` test pass, without a new scheduler:

1. **Durable linkage.** A migration adding `run_links(parent_run_id, child_run_id, kind, state, resume_node_ids_json, created_at)`, with kind `linked_repair`. It is written in the same transaction that creates the repair run. Who may create it is set by the ADR-0009 Judge decision path (`judgeAttention.mjs`, which already returns `linkedContinuationRequired: true`, but nothing acts on it).
2. **Restart-surviving suspension.** In `Engine.recover()` (engine.mjs:158–186), a parent that is `waiting_for_user` **with an open `linked_repair` link** stays `waiting_for_user` with its pause reason, rather than becoming `interrupted`. Unstarted attempts are still canceled and running ones interrupted, as today. After `recover()`, rebuild the in-memory `this.runs` entry for such parents, so that `recoverRun` and the scheduler can address them. Today `recoverRun` refuses any run missing from `this.runs`.
3. **Engine-initiated continuation.** On startup, and on every repair-run terminal transition (`runEvent(..., 'succeeded')`), the Engine evaluates open links:
   - **An interrupted repair** gets a linked continuation run, created by `captureRun` from the repair's own snapshot with `mode: 'node'` per remaining node. `reuseSource()` already supplies committed predecessors, so the repair's Developer and Watcher are not re-invoked, and the interrupted or canceled Judge is re-run as a new attempt, never marked succeeded.
   - **A succeeded repair** has its link closed and the parent resumed through the existing `waiting_for_user:retry` transition on the stored resume nodes.

   This reuses the existing lifecycle table, `captureRun`, `planRun` and `reuseSource`. No new scheduler or run state is needed.

   Files: `runtime/core/engine.mjs` (`recover`, `recoverRun`, the run-terminal hook), `runtime/core/judgeAttention.mjs` (link creation on an authorized decision), a new `docs/storage/m14.sql`, and the runtime API schema for exposing link state.
4. **Shutdown attribution.** In `Engine.shutdown()` (engine.mjs:2254), set `record.stopReason = 'Runtime shutdown; the attempt outcome is unknown.'`, or transition such attempts to `interrupted`, so that a lifecycle restart is not journaled as a user Stop. This is a one-line correctness fix to the audit trail. It is not made here, because this task is verification-only.
5. **Production Judge-only lifecycle authorization** does not exist at all. That belongs to the ADR-0008/0009 implementation, not to this gap.

Two additional notes:

- **The runner's `--fixture-state` hook** (runtime/runner.mjs:401–405) is correctly gated by `!PACKAGED_RUNTIME`, and the packaged runner's option allowlist rejects the flag. However, the literal dynamic `import('./tests/fixture-adapters.mjs')` may be bundled into `dist-runtime/runner.mjs` by esbuild. Confirm at the next `runtime:bundle` that the bundle contains no fixture code, or compile the branch out.
- **The previous test created test-only tables** inside the production store schema. That is acceptable only in throwaway roots, and its findings must not be read as production behavior.

## F. Verification result

### PARTIAL

Durable state, output reuse and safe handling of interrupted work across a real OS process restart are verified. Every continuation transition, from resuming the repair to scheduling the parent, still requires an external actor, and production has no linkage, no restart-surviving suspension and no Engine-initiated continuation. The previous `PASS` was a false positive created by harness scheduling and test-only tables.

## Commands and results

| Command | Result |
| --- | --- |
| `node --disable-warning=ExperimentalWarning --test runtime/tests/workflow-continuation-strict.test.mjs`, run 1, fresh profile | exit 0. Actual-behavior test **ok**. Required-behavior test **not ok # TODO** ("the repair workflow completes after restart": expected true, actual false) |
| The same command, run 2, fresh profile | exit 0, identical results |
| `node --disable-warning=ExperimentalWarning --test runtime/tests/workflow-continuation.test.mjs` | exit 0, 2/2 ok (relabelled harness-driven test and interrupted-attempt test) |
| `npm test` | exit 0. 642 tests: 641 pass, 0 fail, 0 cancelled, 1 todo (the strict required-behavior test, `not ok 631 … # TODO`) |
| `npm run docs:check` | exit 0, `"errors": []`. Documentation checks are not evidence of continuation |

No network or external model API was used. All provider invocations were the repository's fixture CLI.

## Files changed

- `runtime/tests/workflow-continuation-strict.test.mjs`: new strict, observation-only test. It contains an actual-behavior test and a `todo` required-behavior test sharing one scenario. Setting `DESZO_KEEP_STRICT_TRACE=<file>` writes the trace.
- `runtime/tests/workflow-continuation.test.mjs`: relabelled only. Its title now says "harness-driven", and comments mark the test-local lifecycle check and the test-only tables. Its logic is unchanged.
- This report. The previous report is left unchanged.

No production code, profile, installation or commit was changed.
