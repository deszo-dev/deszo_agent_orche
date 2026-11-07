# P1 — Durable Workflow Continuation

## Verdict

**P1 VERIFIED WITH LIMITATIONS.**

A real published three-node workflow (A deterministic → B real Codex CLI under Process Custody → C deterministic verification) was replaced at Engine A → Engine B while Codex was running. Engine B restored the original Run, reattached the same Codex process and Custody invocation, settled B once, ran C once after B, and finished the original Run as `succeeded`, with no continuation API call and no new Run. The deterministic suite, the full regression on the frozen candidate, and the Rust host suite all pass.

It is not "VERIFIED" without qualification because some restart branches are implemented and reviewed but not separately tested (section 19), and because several classes of Run keep the restart rule they had before P1 (section 13). Those are listed in section 19.

Machine-readable evidence:

- Real Codex, frozen candidate: [2026-10-26-p1-codex-continuation-real.json](evidence/2026-10-26-p1-codex-continuation-real.json)
- Earlier live attempts (kept, not overwritten): [attempt 1](evidence/2026-10-26-p1-codex-continuation-real-attempt1.json) (harness assertion defect after a successful Run), [attempt 2](evidence/2026-10-26-p1-codex-continuation-real-attempt2.json) (verified, but on source before the review fixes)
- Regression summary for the frozen candidate: [2026-10-26-p1-regression-summary.json](evidence/2026-10-26-p1-regression-summary.json)

## 1. Objective

After Engine A terminates, Engine B must restore the active Run from durable state under its original Run identity and published version, keep completed nodes and their accepted outputs, reattach recoverable in-flight executions, and schedule the remaining graph without a user action. Surviving a provider process is not the goal; continuing the workflow is.

## 2. Existing recovery behavior (baseline, commit 4165707 plus the uncommitted Custody work)

- `recover()` (`runtime/core/engine.mjs`) interrupted every active Run whose attempts were not Custody-resumable: running attempts were marked `interrupted`, unstarted attempts `canceled`, and the Run became `interrupted` (terminal).
- Custody-resumable Runs (one running attempt, Host-owned) were resumed by `resumeCustodyAttempts`. Their Run stayed `running`. Their downstream nodes were scheduled only through the in-memory scheduler state the resume created.
- Queued Runs were interrupted at restart, not started. `waiting_for_user` Runs were interrupted at restart, so the user could not act on them. `recoverRun` requires the in-memory Run state, which restart did not rebuild.
- Nothing verified that the Run's snapshot still matched its publication.

## 3. Confirmed gaps (measured, not inferred)

| # | Gap | Evidence before the fix |
|---|---|---|
| G1 | A Run between nodes (completed A, unstarted B) was canceled and interrupted at restart. | Code reading of `recover()` before the change: the unstarted attempt is canceled and the Run interrupted. Not run against the unmodified engine. |
| G2 | A Run whose only remaining work was already accepted (B accepted, C not yet dispatched) was interrupted. | Code reading: the same restart rule applies. |
| G3 | A queued Run was interrupted instead of started. | Code reading; not tested (section 19). |
| G4 | A `waiting_for_user` Run was interrupted, and its control was lost. | Code reading: restart interrupted every active Run, waiting ones included. |
| G5 | Nothing rebuilt the in-memory state of continued Runs. | Code reading: `recoverRun` requires `this.runs`, which restart did not rebuild. |
| G6 | The published definition a Run executes was not verified on recovery. | Code reading. P1-13 and P1-13b prove the verification and the store's refusal. |

The baseline was not re-run to observe these gaps, so this section records them from source, not from a failing run.

## 4. Selected minimal implementation

No new table, no migration, no new scheduler, no new public API. The change is in `runtime/core/engine.mjs`:

- `recover()` decides per Run: keep it for Custody resume (unchanged), leave a queued Run to `startRun`, continue an eligible Run (`rebuildRunState` journals `continuation.reconciled` and rebuilds the in-memory state), or apply the existing interrupt rules.
- `publishedDefinitionIntact`, `restartGatesPass`, `canContinueRun`, `isLinkedRun`, `rebuildRunState`: the eligibility and the snapshot check.
- Test-only fault points (`custodyFaultPoint`, active only when `DESZO_CUSTODY_TEST_FAULT` names the point): `after_invocation_commit`, `after_settle:<nodeId>`, `before_run_settle` (terminal transitions only).

Why this is minimal: the durable records already existed. The captured snapshot and plan artifacts give the graph, `attempts` give progress, outputs are committed in the same transaction as the attempt's success, and the journal gives history. Only the restart decision and the in-memory rebuild changed.

## 5. Durable execution model

| Needed for recovery | Persisted record (existing) |
|---|---|
| Run identity and state | `runs.id`, `runs.state` |
| Published version and digest | `runs.published_version_id`, `runs.definition_digest`, `runs.execution_hash`, `workflow_publications.*` |
| Execution graph | `runs.workflow_snapshot_artifact_id` (immutable artifact, digest verified on read) |
| Plan and frozen nodes | `runs.plan_artifact_id` |
| Node progress | `attempts` (state, ordinal, `invocation_artifact_id`, `process_id`), `node_instances` |
| Accepted output | `attempts.outputs_artifact_id`, committed with the `succeeded` transition in one transaction |
| Custody invocation | `attempt_custody`, `custody_workspace_holds`, Host records |
| History | `journal_events` (per-Run sequence) |

## 6. Published workflow version handling

- A Run is bound to the publication it was created from (`runs_published_binding_insert` and `_update` triggers in `docs/storage/m15.sql`). The binding cannot be changed, and a Run can only bind to a publication with the same digest and snapshot.
- Publications are immutable (triggers `published workflow versions are immutable`).
- Recovery loads the Run's own snapshot, never the latest publication. P1-12 publishes v2 while a Run runs on v1, replaces the Engine, and checks that C reads v1's paths and that recovery publishes nothing.
- `publishedDefinitionIntact` refuses continuation when the snapshot is missing or fails its digest (`CorruptionError` only), when its canonical hash differs from `execution_hash`, or when the publication no longer names the same snapshot, digest and execution hash. The refusal is an explicit interrupted reason ("Recovery refused: the published workflow definition of this Run is missing or inconsistent").

## 7. Run and node recovery lifecycle

1. Startup acquires `runner.lock` (unchanged).
2. `recoverSurvivors` handles provider processes the Engine recorded (unchanged).
3. For each active Run: skip if held (linked repair, lifecycle gate); a queued Run with passing gates is left to `startRun`; otherwise, if the Run is resumable (Custody), resume it; if it can continue, rebuild and journal it; if not, apply the existing interrupt rules.
4. `reconcileContinuations` (existing) and the runner's `startRun` pump the scheduler; continued Runs are dispatched by `pumpRun`'s normal readiness rules.

## 8. Automatic scheduling after startup

Continued Runs are in `this.runs` before the first pump. `startRun` and `reconcileContinuations` each queue a pump, so dependent nodes are dispatched without any API call. The first dispatch after restart is observed in P1-02 (B dispatched after A's restart), in P1-03 (C dispatched after B's), and in the real run (Node C dispatched after Node B was accepted, journal sequences 60 and 68).

## 9. Active Custody invocation reconciliation

Unchanged. A Custody-resumable attempt is reattached through the Host's record: same attempt id, same OS process (real Codex: PID 12632 with creation identity `2026-10-26T09:37:18.6179252Z` before and after Engine B), committed stdout offsets continued. A Custody attempt that is scheduled with an attempt-custody row or an invocation is never relaunched by P1 (section 12).

## 10. Completed-node preservation

Accepted nodes are never executed again: their attempts stay `succeeded` and their outputs are read from the artifact store by dependents. P1-02 counts launches (A: one writer launch across the replacement), P1-03 and P1-17 count settlements (exactly one each), and the real run's journal shows one `succeeded` transition per node.

## 11. Waiting and stopped Run behavior

- `waiting_for_user` survives a replacement and stays operable (P1-09: waiting after the replacement, the controller-independent `close` decision accepted, the failed node not relaunched).
- A pending Stop still ends the Run without completing it, and nothing is launched (P1-10: final state `canceled` or `interrupted`, the provider process ended, C never accepted).
- Terminal Runs are not active and are not reopened (P1-02 restarts a finished Run and asserts no change).

## 12. Crash-boundary matrix

| Boundary | Behavior | Evidence |
|---|---|---|
| CP-01 after creation, before first dispatch | queued Run started by `startRun` | code path; not separately tested |
| CP-02 after A accepted, before B dispatched | B and C run on Engine B; A not rerun | P1-02, P1-NC-02 |
| CP-03 invocation committed, not launched | not relaunched; Run interrupted (fail closed) | P1-14 |
| CP-04 Host launched, Engine did not record `running` | existing Custody lost-launch protection | H3-11, PC-22 (existing, pass) |
| CP-05 while Codex runs | reattached to the same process | P1-01, real run |
| CP-06 provider completes while Engine absent | settled once from the Host record; C runs | P1-04 (P1-E2E-02) |
| CP-07 output committed, ack lost | no duplicate commit | SP-02, SP-03 (existing, pass) |
| CP-08 B accepted, C not dispatched | C runs once | P1-03 |
| CP-09 final node accepted, Run not finalized | Run finalized, no node rerun | P1-17 |
| CP-10 during Stop | Stop meaning kept, nothing launched | P1-10 |
| CP-11 waiting for user | stays waiting | P1-09 |
| CP-12 repeated recovery | no duplicate attempt; a second Engine is refused by `runner.lock` | P1-02 (restart after success); RL-FIX-01 (existing) |
| CP-13 Host unreachable | uncertainty preserved, no false success | H3 outage tests (existing, pass) |
| CP-14 published version missing or inconsistent | refused explicitly; never substituted | P1-13 (execution hash), P1-13b (store refuses digest changes) |

## 13. Uncertain side-effect limitations

- An attempt whose invocation was committed but whose launch cannot be confirmed is never relaunched. The Run is interrupted (P1-14). This is conservative: the launch may have happened.
- An attempt that was `running` at restart, or interrupted by a runtime shutdown, is interrupted. Its Run is interrupted, not offered for a decision. Otherwise a retry would repeat an unknown external effect (the existing contract; `rust-host-lifecycle` negative and `workflow-continuation-negative` managed-shutdown tests pin it).
- P1 does not guarantee exactly-once external side effects of arbitrary integrations. It guarantees that a supported Custody or deterministic node is not silently repeated.

## 14. Run classes kept on the pre-P1 restart rule

These continue to be interrupted at restart, as before:

- Ordinary (non-Custody) provider processes that were running when the Engine ended. They do not survive Engine termination in this codebase, and P1 does not claim otherwise (P1-NC-01).
- Loop, Map and Managed Task constructs (recovery of these is not part of P1).
- Linked Parent and Repair Runs (ADR-0008; Parent/Repair coordination is P2's scope).
- Supervised Runs with an active controller grant (their observer is in memory and is not re-armed by P1).
- Host-bound runtimes (`hostAuthority`): their admissions and deadlines are in memory.
- Chat Runs.
- Runs created with a legacy journal (version 1), whose event schema cannot carry continuation events.
- Any Run while a process that a restart could not confirm ended is still alive.

## 15. Deterministic tests

Files: `runtime/tests/workflow-p1-continuation.test.mjs` (10 tests) and `runtime/tests/workflow-p1-published-and-ordinary.test.mjs` (3 tests). They start real Rust Host and Engine processes; the provider is the deterministic fixture (`custody-cli.rs`), a real OS process. None of the tests is mocked. Each was run after a fix, and the failures that preceded the fixes are noted.

| ID | Scenario | Result |
|---|---|---|
| P1-01 | Engine replaced while B runs; C once after B | pass |
| P1-02 / 05 / 11 | Restart after A accepted; repeated recovery of a finished Run changes nothing | pass |
| P1-03 / CP-08 | Restart after B accepted, before C | pass |
| P1-04 / P1-E2E-02 | B finishes while no Engine is attached | pass |
| P1-09 / 19 | Failed B: waiting survives replacement, operable | pass |
| P1-10 | Pending Stop survives replacement | pass (strengthened to assert the Stop's outcome) |
| P1-12 | Published v1 continues after v2 is published | pass |
| P1-13 | Execution hash inconsistent: refused, explicit reason | pass |
| P1-13b | Store refuses to change a published digest, or rebind a Run | pass |
| P1-14 / CP-03 | Invocation committed, not launched: not relaunched | pass |
| P1-17 / CP-09 | Crash after last node, before Run finalization | pass |
| P1-NC-01 | No Custody: running CLI at Engine stop is interrupted, not relaunched | pass |
| P1-NC-02 | No Custody: restart between nodes continues | pass |

Covered by existing tests that still pass (not re-implemented): P1-06 (output replay, SP-02..SP-04), P1-07 (lost launch reply, H3-11), P1-08 (workspace hold through recovery, H3-05/06), P1-15 (second Engine refused, RL-FIX-01/07), P1-16 (stale generation fenced, PC-04/14), P1-18 (Host unavailable, H3 outage tests).

Discrimination: the scenarios were not run against the unmodified engine, so this document does not claim that each one fails on the baseline. What was observed: the first runs failed on test-side errors (workflow validation, an attempt-count assertion that wrongly counted planned attempts, and a constraint on the tampered hash), and each was corrected before the final run. The suites that exercise the same restart path (process-custody, custody-replay SP-06, restart-control, linked-repair-isolation, the Host shutdown negatives) did fail on the first engine change and were addressed as described in section 18.

## 16. Real Codex acceptance

Harness: `runtime/tests/p1-codex-continuation-real.mjs` (opt-in, not a `*.test.mjs`). Live model `gpt-6-luna`, the model recorded in the Stage 1 report. Codex CLI `codex-cli 0.164.0-alpha.11.1`, executable SHA-256 `1103e9e09c71fa2cd0afd6d8f3b9a2d63174fe8efd7cb5bd09f1cb14ef58a098`. Rust Host SHA-256 `671835698a0d24c9dc739aef742fc0173d04beb87dfa10d635f17f7f7e237919`.

Final run (frozen candidate):

| Item | Value |
|---|---|
| Published workflow | `p1-real-codex-continuation`, version id `ca08c50e-8892-4849-926a-3d6652cf04d1` |
| Run | `51d1d7ff-feae-4757-9140-c86b8d9d08d4`, final `succeeded` |
| Nodes | A `node-a` (text), B `node-b` (Codex, Custody), C `node-c` (file input, After B), plus result viewers |
| Host PID | 33264 |
| Engine A PID / identity | 21396 / `2026-10-26T09:35:39.6307329Z`, Host epoch 1 |
| Engine B PID | 34592, Host epoch 2 |
| Codex PID / creation identity | 12632 / `2026-10-26T09:37:18.6179252Z` (same before and after Engine B) |
| Custody invocation | `60531fe8-c297-48b4-8e60-ff456916fd16`, one Host record |
| Attempts | A `7a9ade84-…`, B `dc401dbe-…`, C `ccf2b9e6-…` |
| Launches | Node A is a static text node (no provider launch); Node B: 1 (`CLI process launched` once) |
| Settlements | A 1, B 1, C 1 |
| Ordering | B accepted at journal sequence 60; C accepted at sequence 68 |
| Gate | READY published by Codex at 09:37:39; Engine A terminated 09:37:40 (Host and Codex alive); Engine B reattached 09:37:42; RELEASE written after reattachment |
| Independent project verification | `node --test` 3/3 pass; `normalizeCount` probe `[12,0,4,0,0,0]` |

Attempt history: attempt 1 completed the Run and failed a harness assertion (it compared Node C's planning event, not its acceptance) before writing its journal; the Engine store was then deleted by the first harness version, so only its timeline survives. Attempt 2 verified on source before the review fixes. The final run is on the frozen candidate.

Project result Codex produced (workspace `C:\my\2026\deszo-p1-codex-workspace-pVadES`, outside the repository): `normalizeCount` accepts base-10 digit strings, a regression test was added, and the README contract was updated.

## 17. Independent review

Method: one fresh-context, read-only reviewer (general-purpose agent) read the modified source and tests, ran no tests, and reported findings with file:line. Its findings and dispositions:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Medium | Host-permitted Runs continued without host bookkeeping | Fixed: continuation is off in host-bound runtimes (`hostAuthority`). Not separately tested. |
| 2 | Medium | `recoveryBlocked` not enforced for continued or queued Runs | Fixed: an unconfirmed survivor blocks all continuation, as it blocks new Runs. Not separately tested. |
| 3 | Medium | Queued shortcut bypassed the continuation gates (supervised, chat, unconfirmed) | Fixed: queued Runs use the same gates (`restartGatesPass`). Not separately tested. |
| 4 | Medium (latent) | Journal v1 cannot carry continuation events; startup would throw | Fixed: continuation requires journal version 2. Not separately tested. |
| 5 | Low | Broad `catch` in the snapshot check; no execution-hash comparison | Fixed: only corruption is a verdict; the publication's execution hash is compared. |
| 6 | Low | One Run's scheduler-state failure would reject Engine startup | Fixed: `rebuildRunState` isolates it and interrupts only that Run. Not separately tested. |
| 7 | Low (tests) | P1-10 asserted only "not succeeded" | Fixed: asserts `canceled` or `interrupted`, and that the provider process ended. P1-14 and NC-01 are kept as boundary cases; they also pass on the baseline and are not P1 proof. |
| 8 | Low | SP-06 expectation change; a stale PoC review record | Justified (section 18). PoC review record carries superseded notes. |
| 9 | Note (pre-existing) | A crash between the spawn and the `running` transition leaves an untracked live CLI (`runtime/core/engine.mjs`, the `UPDATE attempts SET process_id` in the spawn handler) | Unresolved, pre-existing; P1 cancels or interrupts such an attempt and never relaunches it (section 19). |
| 10 | Note | `before_run_settle` fired for non-terminal transitions | Fixed: fires only for terminal transitions. |

Reviewer's "no finding" areas, checked by reading: eligibility SQL against the migrations; the hash chain between capture, publication and `readBytes`; double dispatch; relaunch after unknown outcome; terminal, stopping, held and linked Runs; waiting Runs; Custody resume and continuation mutual exclusion; fault-point gating; scope (no scheduler, Judge or route change).

Review was run before the fixes. A second review pass was not run; the fixes were tested (section 18) rather than re-reviewed.

## 18. Full regression and test changes

- Baseline before any P1 change: `npm test`, 790 pass, 0 fail (`runtime/tests/*.test.mjs`).
- First regression with P1 (before the review fixes): 799 tests, 6 failures. All six were explained by the restart rule; they were fixed by the rule itself, not by weakening the tests, except SP-06 (below).
- Final regression on the frozen candidate: **803 pass, 0 fail, exit 0** (790 baseline plus the 13 new P1 tests).
- `cargo test --manifest-path lifecycle-host/Cargo.toml`: 23 passed (matches the Stage 1 Rust count). The Rust source is unchanged by P1.
- `npm run docs:check` and `npm run build`: see the regression summary evidence.

Test changes, all visible in the diff:

- `runtime/tests/custody-replay.test.mjs` SP-06: expected `interrupted` → `succeeded`. The old comment encoded the rule P1 replaces. The accepted outcome is still not repeated, and the settlement and launch counts are unchanged.
- P1-13 and P1-13b were changed to match the store's guarantees: the digest-mismatch branch is defense in depth behind triggers that refuse the state, so the test proves the refusal.
- Existing ADR-0008, supervision, Host-shutdown and restart-control expectations were not changed. Their Runs keep the pre-P1 rule (section 14).

## 19. Remaining limitations

Accepted P1 limitations:

- Section 14 Run classes keep the restart rule.
- Ordinary (non-Custody) provider processes do not survive Engine termination; their Runs are interrupted, not relaunched.
- Unknown-outcome attempts end their Run as interrupted; P1 never offers a decision for them and never repeats them.
- P1 does not guarantee exactly-once external side effects.

Deferred P2 Parent/Repair functionality: linked Parent and Repair Runs, and the restart of their suspended state.

Deferred P8 advanced continuation: Loop, Map and Managed Task recovery.

Confirmed unresolved defect (pre-existing, not introduced by P1): finding 9. Between the spawn of a Node-owned CLI and the write of its `running` transition, a crash leaves the process untracked. P1 never relaunches the attempt, but the process is not killed by recovery. Closing this needs an atomic spawn record, which is outside P1.

Branches implemented but not separately tested (reviewer findings 1–4, 6, and the draining continuation): host-bound runtimes, `recoveryBlocked`, queued supervised or chat Runs, journal version 1, a Run whose scheduler state cannot be rebuilt, and draining Runs. The fixes are in the code and were reviewed by reading. Testing them would upgrade the verdict to unqualified.

## 20. Follow-up requirements for Parent/Repair coordination (P2)

- P2 can rely on the continuation primitive only for ordinary Runs. Linked Runs (`run_links`) and Runs with an active control grant are excluded by `restartGatesPass`; P2 must add its own restart rule for suspended Parents and Repairs before those Runs can continue.
- The `continuation.reconciled` journal event and `rebuildRunState` are reusable. Their payload uses `origin: ENGINE`.
- `isLinkedRun` must be replaced with P2's own relation check; today it blocks continuation for both sides of a link.
- P2 should decide how a suspended Parent resumes after a Repair completes across an Engine replacement. ADR-0008's startup reconciliation (`reconcileContinuations`) already handles the terminal-repair case.

Next-stage readiness: the continuation mechanism is sufficient to begin P2 without redesigning P1, because P1 added no scheduler and changed no ADR-0008 behavior. The exclusions above are the contract P2 must extend.

## 21. Git inventory and proposed staging scope

Nothing was staged, committed, pushed, merged, reset or rebased.

P1-owned, new (safe to stage as a set):

- `runtime/tests/workflow-p1-continuation.test.mjs`
- `runtime/tests/workflow-p1-published-and-ordinary.test.mjs`
- `runtime/tests/p1-codex-continuation-real.mjs`
- `docs/reviews/2026-10-26-p1-durable-workflow-continuation.md`
- `docs/reviews/evidence/2026-10-26-p1-codex-continuation-real.json`
- `docs/reviews/evidence/2026-10-26-p1-codex-continuation-real-attempt1.json`
- `docs/reviews/evidence/2026-10-26-p1-codex-continuation-real-attempt2.json`
- `docs/reviews/evidence/2026-10-26-p1-regression-summary.json`

P1-only, tracked (the whole file diff is P1):

- `runtime/tests/custody-replay.test.mjs` (SP-06 expectation only; no other hunk)

Mixed: contains pre-existing uncommitted Process Custody work and P1 hunks. Stage P1 hunks only (`git add -p`):

- `runtime/core/engine.mjs`: P1 hunks are `recover()`, `publishedDefinitionIntact`, `isLinkedRun`, `restartGatesPass`, `rebuildRunState`, `canContinueRun`, and the fault points in `executeAgent`, `settleAgentProcess` and `finishRunIfDone`.
- `docs/reviews/2026-10-24-process-custody-poc.md`: two superseded notes on SP-06 (lines 185 and 1089).

Pre-existing, not P1 (do not stage with P1): every other modified or untracked file in `git status` at the start of this task, including `runtime/core/custody.mjs`, `runtime/tests/process-custody.test.mjs`, `runtime/tests/custody-support.mjs`, the Rust host, the Stage 1 review and evidence, and `runtime/tests/codex-custody-real.mjs`.

Note on identity: this review and the evidence record the candidate's source hashes in `2026-10-26-p1-regression-summary.json`. Any edit to the mixed or P1 files after this point invalidates the candidate and needs a repeat of the real proof.

## 22. P1.5 — Recovery Coverage Closure

This section records the P1.5 follow-up without rewriting the P1 live Codex evidence above. Statements in section 19 that restart branches were implemented but not separately tested were accurate at the P1 freeze; this section supersedes that test-coverage status for the branches below.

P1.5 adds regression coverage and two small corrections to existing P1 recovery gates. It does not add Loop, Map, Managed Task, chat, linked Parent/Repair, Host-bound or active-supervision continuation.

### 22.1 Existing coverage inventory

- `runtime/tests/workflow-p1-continuation.test.mjs` already covered successful Engine replacement during an active Custody invocation (P1-01), completion while Engine A was absent (P1-04), restart after accepted results, repeated recovery, pending Stop and terminal idempotency. P1.5 strengthens P1-04's explicit Engine-absence assertion and its byte-level stream checks.
- `runtime/tests/workflow-p1-published-and-ordinary.test.mjs` already covered published-version binding and the ordinary non-Custody boundary: an in-flight CLI is not relaunched (P1-NC-01), while a clean restart between nodes continues (P1-NC-02). P1-NC-02 now also verifies its external marker and adapter invocation count.
- `runtime/tests/linked-repair-isolation.test.mjs` already covered fresh-Engine recovery for linked Parent/Repair workspace conflicts (PDE-R10-11/13). The existing tests remain unchanged by P1.5.
- Process Custody spool replay, process-tree proof and workspace-hold behavior remain covered by `runtime/tests/custody-replay.test.mjs` and `runtime/tests/process-custody.test.mjs`.

### 22.2 Persisted restart eligibility

`Engine.recover()` uses persisted Run and attempt data, the captured workflow snapshot and publication binding, Host ownership configuration, linked-run/control-grant records, journal version and unconfirmed workspace state. A normal scheduler continuation is considered only for a published workflow Run in `running`, `draining` or `waiting_for_user`, with no active or unknown-outcome attempt and no Context binding still being written. A queued Run takes a separate shortcut, but it must pass the same `restartGatesPass` checks. Active Custody reattachment now also passes those checks and requires every running attempt in that Run to be Custody-owned.

The shared restart gates reject a blocked recovery, a Host-bound or Host-verification-only runtime, a non-workflow Run, journal version 1, linked Parent/Repair Runs, an active control grant, a snapshot containing a Loop/Map/Task anywhere in its node tree, or an overlapping unconfirmed workspace. The publication snapshot and execution hash must also remain intact. Ineligible active Custody records are stopped through the Host and their Run follows the existing restart outcome. Existing linked-repair hold reconciliation continues to preserve a deliberately suspended Run; P1.5 does not replace that behavior with a generic interruption.

### 22.3 Added P1C coverage

| Case | Persisted branch exercised | Result asserted |
|---|---|---|
| P1C-01 | Queued supervised workflow with a prior approved grant | Interrupted, old grant ended, no attempt or provider dispatch duplicated. |
| P1C-02 | Queued chat Run | Interrupted as chat, same receipt and attempt history, no assistant invocation or duplicate Run. |
| P1C-03 | Host-bound Engine replacement with stale generation | Interrupted without taking over Host ownership or creating attempts. |
| P1C-04 | `recoveryBlocked` after an unconfirmed owned-process result | No dependent dispatch or re-created attempts; a later clean startup clears the temporary startup block but does not reopen the interrupted Run. The test supplies deterministic survivor evidence at the `recoverSurvivors` boundary; it does not claim to create a physically unkillable process. |
| P1C-05 | Persisted journal-v1 history | The disposable store is converted to schema-valid v1 envelopes, including v1 event vocabulary, payload fields, contiguous sequences and canonical hashes. Engine B preserves the accepted history and does not dispatch the scheduled dependent attempt. The test retains 26 historical records in the recorded run. |
| P1C-06 | Real persisted `running → draining` transition after a Host-owned failure | A is already accepted; C is ready but blocked behind B's workspace lock. Engine A closes while the Run is still `draining`; Engine B applies the existing `draining → waiting_for_user` rule, leaves C waiting, and launches nothing. The failing Host process has a durable tree-completion proof and its hold is released. An instance-local seam delays only final Run settlement after the production transition; it never assigns the Run state. |
| P1C-07 | Queued persisted Loop, Map and Managed Task examples | Each Run remains interrupted, with no provider dispatch or attempt recreation. |
| P1C-08 / P1C-11 | Side-effecting A, READY/RELEASE Custody B, verification C; two real Engine replacements | A's external marker remains exactly one; A/B/C each have one provider launch and one settlement; B retains its Attempt/PID and Host record; C starts after B; original Run and publication succeed once. F3 tree proof and released workspace hold are asserted. |
| P1C-10 / P1-04 | B completes through the real Rust Host while Engine A is absent | Engine A exit is now explicitly observed before waiting for B's PID to end. Engine B reuses the same Run/Attempt, launches B once, replays stdout/stderr byte-for-byte from the Host spool, closes all three stream views as complete, settles B and C once, verifies F3 tree completion, then releases the hold. |
| P1C-12 | Active supervised Custody attempt with an active control grant | The active Custody process is stopped through the Host, the Run is interrupted, the grant ends, and no replacement Attempt or process is created. |
| P1C-13 | Active top-level Custody attempt in a persisted workflow that also contains a Loop | The Host-owned process is stopped; the Run is interrupted and neither the Loop nor another Attempt is dispatched. |

P1C-06 tests the real draining transition after B has failed and the Host has proved its process tree ended; it does not claim that a live process remains at the restart instant. Active Custody reattachment and completion during Engine absence are directly covered by P1-01/P1C-11 and P1-04/P1C-10 respectively. This division keeps each test tied to the branch it actually observes.

### 22.4 Confirmed corrections

Test-first P1C-07 cases exposed that the queued-Run shortcut could bypass `canContinueRun`'s Loop/Map/Task exclusion. All three cases initially recovered as `running`. The shared `restartGatesPass` now rejects those node types anywhere in the persisted snapshot. This preserves the pre-P1 interrupted behavior and does not widen continuation eligibility.

The independent review then found that the active-Custody `resumable` shortcut could bypass those same restart gates. Test-first P1C-12 and P1C-13 reproduced reattachment for an active grant and for a Loop workflow. `recover()` now requires `restartGatesPass` before reattaching Custody attempts; excluded Host records are abandoned through the Host. The active paths now match the queued and ordinary continuation gates.

### 22.5 Independent read-only review

The first independent review reported five findings: the active-Custody gate bypass (High); P1C-06 not proving a real draining state or C readiness (Medium); P1C-05 not containing v1 event envelopes (Medium); P1-04 not explicitly waiting for Engine A exit (Low); and recovery-boundary tests lacking enclosing timeouts (Low). The fixes are recorded above: shared gate in the active path, persisted draining with ready-but-lock-blocked C, schema-backed v1 conversion and digest verification, an explicit P1-04 Engine-exit wait, and bounded test timeouts.

After the focused suite, a narrow second read-only review confirmed the High and both Medium findings were resolved and found no remaining Critical, High or contract-breaking Medium issue. A final read-only check confirmed the P1-04 assertion now appears in the Engine-absent test itself. Reviewers made no edits and ran no tests.

### 22.6 Verification and evidence

- Focused recovery/continuation/linked-repair suites: **35/35 passed**, exit 0. The final P1-04 Engine-exit assertion was then run separately (**1/1 passed**) and is included in the full run below.
- Final `npm test`: **815/815 passed**, 0 failed, 0 canceled, 0 skipped, exit 0. This is the final source candidate with the P1-04 assertion included; the 803-test result above remains historical P1 evidence.
- `cargo test --manifest-path lifecycle-host/Cargo.toml`: **23 passed**, 0 failed, exit 0.
- `npm run docs:check`: passed with no validation errors.
- `npm run build`: exit 0. Vite emitted its existing advisory that the minified main JavaScript chunk exceeds 500 kB; the build completed successfully.
- `git diff --check`: exit 0. Git reported only LF-to-CRLF working-copy notices for files already modified in the shared tree.

The P1 live Codex acceptance was not rerun. Its report and evidence remain historical and unchanged; P1.5's deterministic Rust Host fixtures do not claim a live-provider result on this candidate.

Detailed machine-readable results are in `docs/reviews/evidence/2026-10-26-p1.5-recovery-coverage.json`. The direct source/test/schema hashes are in `docs/reviews/evidence/2026-10-26-p1.5-recovery-coverage-source-manifest.json`.

### 22.7 Remaining limits

- P1 still does not continue chat, Loop, Map, Managed Task, linked Parent/Repair, Host-bound or active-supervision Runs. A v1 journal is not upgraded. An uncertain owned process blocks continuation.
- An ordinary non-Custody provider process already running at Engine shutdown is interrupted and never relaunched. A normal Run restarted between nodes remains covered by P1-NC-02.
- P1 does not guarantee exactly-once side effects for arbitrary integrations. P1C-08 proves one external side effect for its deterministic supported fixture.
- P1C-04 uses a deterministic seam at survivor discovery rather than a real unkillable PID. P1C-06's seam delays final settlement after the real draining transition; it does not simulate a still-running Custody process during restart.
- The previously documented crash window between OS process creation and durable identity remains outside this task. Recovery does not relaunch an unknown-outcome attempt, but that pre-existing window is not closed here.

P1.5 closes the identified deterministic coverage gaps for the existing recovery contract. It does not expand the supported continuation set or replace P2's separate Parent/Repair coordination work.
