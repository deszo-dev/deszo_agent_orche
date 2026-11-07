# Engine-native continuation: implementation and proof across a real restart

- Date: 2026-10-22
- Subject: closing the gap found by the [independent verification](2026-10-22-workflow-continuation-independent-verification.md), which found the earlier `PASS` to be a false positive.
- Scope: Suspend → linked repair → Engine restart → autonomous repair completion → autonomous parent resumption, under [ADR-0008](../adr/0008-portable-ephemeral-lifecycle-host.md) section 7 and [ADR-0009](../adr/0009-workflow-native-judge-and-exclusive-external-input.md) section 6.
- Branch: `codex/adr-0003-0005-completion`, working tree, **nothing committed, pushed, merged or deployed**.
- Verdict: **PASS for the scoped proof** (section 10). It holds only for the unbound runtime with deterministic fixture providers. Limits are listed in section 11.

## 1. Initial capability gaps

Verified against the repository before any change. Each claim below was checked in source, not taken from the earlier reports.

| Capability | Existing implementation | Gap found |
| --- | --- | --- |
| Durable run history | `runs`, `attempts`, `artifacts` and the journal (`m1`–`m13`) survive restart | None |
| Parent–repair linkage | No production column or table. Only the test-only `workflow_continuations` table | Missing |
| Workspace ownership | `one_active_run_per_workspace`, a partial unique index over the active states, including `waiting_for_user` (`docs/storage/m2.sql`) | None. The repair must run in a second workspace |
| Startup reconciliation | `recover()` interrupts every active run, including `waiting_for_user` (`engine.mjs`, `ACTIVE_SQL`) | A suspended run was converted to `interrupted` |
| Repair continuation | None. Runs are created only by a caller | Missing |
| Repair completion hook | None. A terminal transition did not notify any parent | Missing |
| Parent continuation | `retry` existed, but it needs in-memory run state, and that state is empty after restart | Missing |
| Lifecycle proposal | No production route, parser or role gate. `judgeAttention.mjs` returned `linkedContinuationRequired` and nothing acted on it | Missing |
| Idempotency | Only per-request command receipts | No compare-and-set guard on continuation |
| Shutdown audit | `shutdown()` set `stopRequested` without a reason, so an in-flight attempt was journaled `canceled`, "Stopped by the user." | Misattributed |

The workspace constraint was checked before design: a suspended parent may legally keep its workspace, and a repair in a different workspace does not conflict with it. The DB index is the authority, and it was not altered.

## 2. Production changes

Each change is attributed to a specific file. Nothing else was edited for this task.

| File | Change |
| --- | --- |
| `docs/storage/m14.sql` (new) | Additive migration: `run_links` (one open link per parent and per repair, with a candidate digest and a checkpoint artifact) and `lifecycle_operations` (one intent per run, moving to `verified` with a receipt). Applied history is not rewritten. |
| `runtime/core/migrations.mjs` | Registers `m14.sql`. The bundle copies every catalogued migration. |
| `runtime/core/linkedRepair.mjs` (new) | The continuation module, installed on the Engine prototype like `judgeAttention.mjs`: link creation, proposal validation, lifecycle gate, receipt, compare-and-set resumption, startup reconciliation, and repair-outcome recording. |
| `runtime/core/engine.mjs` | Installs the module; reconciles after `recover()`; `recover()` keeps held runs; `loadRunState` extracted from `startRun`; the agent success path validates a Judge proposal before commit; graceful shutdown is journaled `interrupted` with "Runtime shutdown; the attempt outcome is unknown."; the repair outcome is recorded in the same transaction as its terminal state, including a user close; `retry` takes an internal reason. |
| `runtime/runner.mjs` | Two routes behind the first-party guard: `POST /api/v2/runs/:id/linked-repair` and `POST /api/v2/runs/:id/lifecycle-receipt`. |
| `docs/schemas/workflow.schema.json` | Optional agent `config.role`, enum `["judge"]`: the designated Judge (ADR-0009). |
| `docs/schemas/runtime-api-v2.schema.json` | `linkRepairRequest` and `lifecycleReceiptRequest`, both closed (`additionalProperties: false`). |
| `docs/schemas/journal-event-v2.schema.json` | A typed branch for the ten `continuation.*` events, each requiring `origin` (`ENGINE` or `HOST_RECEIPT`). Four lifecycle refusal codes added to the `attempt.error` enum. |
| `runtime/tests/fixture-cli.mjs` | Deterministic scenario `lifecycle-proposal`: states the candidate from the workspace file, or proposes nothing. |
| `runtime/tests/workflow-continuation-strict.test.mjs` | **Replaced.** The observation-only test that documented the gap is now the required behaviour. |
| `runtime/tests/workflow-continuation-negative.test.mjs` (new) | Nine negative and boundary cases, each on the Engine's real routes and durable state. |
| `runtime/tests/loops.test.mjs` | One existing assertion was out of date. The M1 migration test required the final schema version to be 13; with `m14` the catalogue ends at 14. It now asserts the store reaches the end of the catalogue (`MIGRATION_PATHS.length`), and its title no longer names a fixed version. No other assertion changed. |
| `runtime/tests/workflow-continuation.test.mjs` | Only its two test-only tables renamed with a `test_only_` prefix. The collision with the production `lifecycle_operations` table had made the test fail and hid its assertion behind a cleanup error. Assertions unchanged. |

**Design choice: the parent is resumed in place, not by a new continuation run.** The spec's preferred direction created a new linked run. The smaller correct change follows ADR-0008 section 7 Step D. The parent's run keeps its identity, and its suspended node is retried through the existing `retry` transition. Creating a new run instead would need reuse across the whole workflow, but `planRun` reuses predecessors only in `node` mode, and the change would have reached far more of the planner. The workspace constraint is respected either way: the parent keeps `main`, and the repair runs in `main-repair`.

## 3. Workspace ownership model

- The suspended parent stays `waiting_for_user` in `main`. It is the single active run of that workspace (`one_active_run_per_workspace`). Test: a second run in `main` is refused with `409`, both while the parent is suspended and at the end of the scenario.
- The repair runs in `main-repair`, a different workspace, so it never shares the index. Test: a second repair run in `main-repair` is refused with `409` while the first is held.
- The link route refuses a repair in the parent's own workspace (`422`), and it captures the repair with the ordinary `captureRun`, which re-checks the index.

## 4. Startup reconciliation

`initialize()` runs `recover()` and then `reconcileContinuations()`. The steps, in order:

1. Repair outcomes: an open link whose repair is already `succeeded` is recorded as completed. An open link whose repair is `failed`, `canceled` or `interrupted` is recorded as `repair_failed`, and the parent stays suspended.
2. Lifecycle release: a verified operation whose run is still `waiting_for_user` moves the run to `running`.
3. Parent resumption: each `repair_completed` link resumes its parent, and the resume is claimed by a compare-and-set (`repair_completed → resumed`).
4. Rebuild: each held run gets its in-memory scheduling state from its durable snapshot and plan, and a `continuation.reconciled` event (origin `ENGINE`) is journaled.

`recover()` keeps a run held when it is `waiting_for_user`, has no attempt still running, and has either an open or completed link as the parent, or a lifecycle intent. Held runs keep their scheduled attempts. Everything else follows the existing restart rules.

## 5. How repair completion triggers parent continuation

1. A Judge proposal is validated on the designated Judge's success path, before its outputs commit. A valid proposal records a lifecycle intent and moves the repair to `waiting_for_user` in the same transaction. The final node is therefore not dispatched until the Host's receipt.
2. The receipt route validates the operation identity and the candidate digest, and it refuses a receipt outside the gate (`409`). The operation moves to `verified`, and the repair moves to `running`.
3. When the repair run terminates `succeeded`, its link moves to `repair_completed` in the same transaction as the repair's terminal state. `finishRunIfDone` then calls the resumption, and the compare-and-set claims it.
4. Resumption retries the suspended node (`watcher`), which plans a new attempt, and moves the parent to `running`. The parent's Developer is not re-run, because its committed attempt is `succeeded`.

A repair that fails, is canceled, or is interrupted never resumes its parent. A user `close` of the repair records `repair_failed` in the same transaction.

## 6. Duplicate continuation prevention

- Every transition is a compare-and-set on durable state: `open → repair_completed`, `repair_completed → resumed`, `waiting_for_user → running` for a verified gate, and the operation's `intent → verified` guard.
- The link route is idempotent on its request identity (the command receipt), and a second link for a parent is refused (`409`).
- A repeated reconciliation finds the link already claimed and changes nothing. Tested in-process: two extra reconciliation passes create no run, no attempt and no second `parent_resumed` event.

## 7. Chronological execution trace

Source: `docs/reviews/evidence/2026-10-22-engine-native-continuation/strict-run1-trace.json`, the first fresh-profile run. Times are UTC. Origins are the `origin` payload or, for ordinary state changes, `ENGINE`.

| Time | Process / origin | Transition | Identity / evidence |
| --- | --- | --- | --- |
| 17:55:37.450 | ENGINE | Parent run captured and started in `main` | parent `7aa3d34c` |
| 17:55:38.318 | ENGINE | Parent Watcher `failed` ("Simulated transient failure."); parent `draining → waiting_for_user` | production pause path |
| 17:55:38.366 | ENGINE | Repair run captured in `main-repair` | repair `9de93398` |
| 17:55:38.381 | ENGINE | `continuation.linked_repair_opened` | link `44539d7d`, checkpoint, candidate digest |
| 17:55:39.976 | ENGINE | Repair Judge succeeded; `continuation.lifecycle_intent` recorded | operation, candidate digest |
| 17:55:39.977 | ENGINE | Repair `running → waiting_for_user` (lifecycle gate) | the final node stays `scheduled` |
| 17:55:41.354 / 41.980 | ENGINE, Engine B startup | `continuation.reconciled` for the parent, then the repair | B = pid 17892 (A = 33232) |
| 17:55:45.304 | **HOST_RECEIPT** | `continuation.lifecycle_verified` | the only mutating call after restart |
| 17:55:45.306 | ENGINE | Repair `waiting_for_user → running` | — |
| 17:55:45.551–45.998 | ENGINE | `finalize` (the repair's final node) runs and succeeds | its first invocation after restart |
| 17:55:46.042 | ENGINE | Repair `running → succeeded` | — |
| 17:55:46.044 | ENGINE | `continuation.repair_completed` | link → `repair_completed` |
| 17:55:46.053–46.055 | ENGINE | Parent watcher attempt planned; `continuation.parent_resumed`; parent `waiting_for_user → running` | link → `resumed` |
| 17:55:46.137–47.003 | ENGINE | Parent Watcher succeeds, Judge succeeds, Result succeeds; parent `running → succeeded` | — |

Three Engine processes ran in total (A = 33232, B = 17892, C = 25696). Run 1 made 50 HTTP calls, 42 of them `GET`. The eight non-`GET` calls were, before the restart: four setup calls (two workspaces, two workflows), the parent start, the link through the Engine's route, and a conflicting run in `main` that was refused with `409`. After Engine B started, the only non-`GET` call was the receipt. Engine C started after the parent had completed, and it produced no new transition.

## 8. Evidence for ECONT-01 to ECONT-16

Each row cites the test assertion that enforces it. Strict-run results are in `strict-run1.tap` and `strict-run2.tap`.

| ID | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| ECONT-01 | Parent and repair linked durably in production persistence | `run_links` row survives restart (strict test) | PASS |
| ECONT-02 | Suspension respects one active run per workspace | 409 for a second run in `main` and in `main-repair` (strict, negative 2) | PASS |
| ECONT-03 | Repair runs in a legally available workspace | `repairRow.workspace_id === 'main-repair'` (strict) | PASS |
| ECONT-04 | Restart crosses a real OS process boundary | three distinct pids (strict) | PASS |
| ECONT-05 | Engine B discovers unfinished repair from durable state | `continuation.reconciled` by ENGINE for both held runs (strict) | PASS |
| ECONT-06 | Engine B performs remaining repair work without external scheduling | `finalize` invoked after restart and succeeded; no non-`GET` call except the receipt (strict) | PASS |
| ECONT-07 | Repair completion produced by the Engine | `continuation.repair_completed` and the repair's `succeeded` transition, both ENGINE (strict) | PASS |
| ECONT-08 | Engine automatically resumes the parent | `continuation.parent_resumed` ENGINE; watcher `failed, succeeded` (strict) | PASS (in place; see section 2) |
| ECONT-09 | Parent executes its next unfinished operation and completes | parent judge and result succeed; parent `succeeded` (strict) | PASS |
| ECONT-10 | Completed agent operations not repeated by restart | one invocation of each developer; repair judge ordinal 1 (strict) | PASS |
| ECONT-11 | Reconciliation idempotent | a third start creates no run, attempt or invocation; one `parent_resumed` (strict); in-process duplicate reconciliation (negative 1) | PASS |
| ECONT-12 | Unknown-outcome effectful operations not blindly repeated | a repair held in flight is `interrupted` and its Judge is not re-run (negative 9); the existing interrupted-attempt test (CONT 11) | PASS, outside the strict scenario, which has no unknown-outcome operation |
| ECONT-13 | No external user answer required | the only input after restart is the Host receipt, a verified outcome, not an answer | PASS, with the caveat in section 11 |
| ECONT-14 | All provider invocations are deterministic fixtures | Engine processes run only with `--fixture-state`; every invocation is `fixture-cli` | PASS |
| ECONT-15 | Tests do not touch the installed profile | isolated root under `.deszo/tests`; no `test_only_` table in production | PASS |
| ECONT-16 | Managed shutdown is not journaled as a user Stop | negative 9: an in-flight attempt is `interrupted` with the runtime-shutdown reason and never `Stopped by the user.` | PASS |

Negative cases (`workflow-continuation-negative.test.mjs`): duplicate reconciliation; busy workspaces; failed repair; restart in the continuation window; receipt for another candidate; restart without a receipt; Developer proposal refused; wrong-candidate Judge proposal refused; managed shutdown.

## 9. Commands and results

```bash
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/workflow-continuation-strict.test.mjs
```

Run 1 and run 2, each on a fresh profile: `pass 1, fail 0, todo 0`, with no runner process left behind. See `strict-run1.tap` and `strict-run2.tap`.

```bash
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/workflow-continuation-negative.test.mjs runtime/tests/workflow-continuation.test.mjs
```

`pass 11, fail 0`.

```bash
npm test          # full runtime suite; log: docs/reviews/evidence/2026-10-22-engine-native-continuation/npm-test.log
npm run docs:check   # errors: []
```

Full runtime suite, final run on the final code: **`# tests 650`, `# pass 650`, `# fail 0`, `# todo 0`, exit 0**. Log: `docs/reviews/evidence/2026-10-22-engine-native-continuation/npm-test-final.log`.

Earlier full run, before one test expectation was corrected: `# tests 650`, `# pass 649`, `# fail 1`. The single failure was the M1 migration assertion described in section 2, `loops.test.mjs`. It was not a continuation failure. Its log is `npm-test.log`, kept unchanged.

## 10. Verdict

**PASS, for the scoped proof.** The production Engine, in a separate operating-system process, discovered an unfinished linked repair from durable state, completed the repair's remaining work by its own transitions, and resumed the suspended parent in place, with no call to any run API after the restart except the Host's receipt. Duplicate continuation is prevented by compare-and-set and verified by repetition.

The verdict is scoped. It rests on the unbound runtime, on deterministic fixture providers, and on a receipt delivered through a first-party route. Section 11 lists what the proof does not establish.

## 11. Remaining limitations

1. **Host authority is not implemented.** The receipt is accepted only where Host mutations are refused, that is, in an unbound runtime. A host-bound runtime refuses it (`trusted_authority_required`) until the Host binding exists. The lifecycle restart itself is simulated: the test stops and starts the Engine.
2. **The Judge decision path is not connected.** ADR-0009's attention API could request a linked repair (`linkedContinuationRequired`), but the link is created by a first-party route. The ECONT-13 claim therefore means "no answer from a user", not "no human decision anywhere in the design".
3. **The lifecycle proposal is a single marker line** in the designated Judge's final text, `REQUEST_LIFECYCLE_ACTION {json}`, strictly parsed and validated against the linked candidate and checkpoint. ADR-0008 implies a structured contract, which is not yet a versioned schema.
4. **Candidate identity is synthetic.** The harness saves a candidate digest in the repair workspace, and the Judge repeats it. The Engine does not yet derive the candidate from the repair's committed artifacts.
5. **An interrupted repair is not re-executed.** A repair that was in flight at a restart becomes `repair_failed`, and its parent stays suspended for an explicit decision. This is the safe behaviour the spec requires, but it is not automatic recovery.
6. **Only one designated Judge is enforced, and only in linked repairs.** ADR-0009 A9-01 requires exactly one designated Judge in every autonomous profile. That broader rule is not enforced here.
7. **A parent cannot resume if its failed node has been replaced.** The resume targets the node recorded at suspension. A changed workflow is not reconciled by this change.
8. **No concurrency test of two Engines on one profile.** Single-process ownership of a profile is the existing runner-lock behaviour and was not changed.
9. **Schemas were extended** (`workflow`, `runtime-api-v2`, `journal-event-v2`). Existing saved workflows and journals remain valid; the new fields are optional or add branches.
10. **The working tree is uncommitted.** It includes earlier uncommitted work on the same branch. Nothing was committed, pushed, merged or deployed.
