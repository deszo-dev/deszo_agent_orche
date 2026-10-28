# Deszo P4.1 Policy Integration — Fail-Closed Verification

**Date:** 2026-10-28  
**Verdict:** `P4.1 INTEGRATED — FAIL-CLOSED VERIFIED`

## Source identity and starting audit

- P4.1 source: `C:\Users\jusse\.codex\worktrees\p4-1-policy\deszo_agent_orche`, detached at `3357fb08db5fcb2049d37dd54d9781b6a3b7d528`.
- Main target: `C:\my\2026\deszo_agent_orche`, branch `codex/adr-0003-0005-completion`, same HEAD.
- Both worktrees were inspected before changes. Neither had staged changes or an active Node test process. The P4.1 source had the schema, validator, Engine edits and a new policy test. Main had no independent edits to those four targets.
- Main already contained the Native Windows Verification changes in `branchDelivery.mjs`, `processes.mjs`, `taskProcesses.mjs`, `authority.mjs`, and the Branch Delivery, managed-task and ADR-6 regression tests. Three review documents were untracked. These changes and documents remain present.
- Existing stashes (`stash@{0}` and `stash@{1}`) were left untouched.

Final P4.1 target SHA-256 values match between source and main:

| File | SHA-256 |
|---|---|
| `docs/schemas/workflow.schema.json` | `2795F2AD61898AA2ECFC1B7FE89302E40DF9680DA60CD8212F460E1CBCB78C83` |
| `runtime/core/validate.mjs` | `4985D264EFF8FF761EEDB636581332A71611BA298CF158A383C8E81B173BDD56` |
| `runtime/core/engine.mjs` | `BD779C40BB791DD27BA375B84B5D6C4132838989A141620D5FCA7D3FA5DCE2B1` |
| `runtime/tests/workflow-judge-policy.test.mjs` | `27961710398E25F1D43B30FA3CC0CD6E479DB7C6983C46159DAA849EC238E42A` |

## Fail-closed proof

The current focused P4.1 suite passes all 14 tests on both the isolated source and combined main candidate.

| Case | Result and observed behavior |
|---|---|
| FC-01 — Valid publication | Pass. A valid `workflow-judge/1` publication persists the exact policy and authority version; publication alone creates no Run or Attempt. |
| FC-02 — Ordinary workflow | Pass. A workflow without `judgePolicy` executes and succeeds under existing semantics. |
| FC-03 — Legacy Judge role | Pass. A role-only legacy Judge remains valid and executes without acquiring P4 authority. |
| FC-04 — P4 start refusal | Pass. Workflow admission returns `409 workflow_judge_runtime_unavailable` before Run, Attempt or external request rows are created. Provider detection and process counts remain zero. |
| FC-05 — Direct Judge target | Pass. `planRun` rejects designated Judge selection; node and branch admission are refused before execution side effects. |
| FC-06 — Alternate entrypoints | Pass. External admission receives the same refusal. The Host-permit path settles as `not_executed`; direct `captureRun` is also guarded. |
| FC-07 — Existing unsupported Run | Pass. Startup interrupts an old queued P4 Run, cancels its unstarted Judge Attempt, records the unsupported-runtime reason and launches no provider. A completed linked Repair does not resume its P4 Parent: the Parent remains interrupted, the link remains `repair_completed`, no retry Attempt is added, and the refusal event is durable. |
| FC-08 — Publication immutability | Pass. Editing the draft preserves the selected published version, policy identity and digests; admission against that pinned version remains refused. |

## Corrections and transfer

The first read-only review found one blocker: startup continuation reconciliation could call the existing P2 `resumeLinkedParent` path after a P4 Parent had been interrupted. The minimal correction adds the temporary policy check at the start of `Engine.retry`, before attempt lookup or mutation. The existing linked-repair transaction rolls back on refusal and records `continuation.parent_resume_refused`. `runtime/core/linkedRepair.mjs` was not modified. The deterministic FC-07 fixture now covers this completed-Repair/held-Parent case.

The schema, validator and Engine changes were transferred as a working-tree patch; the new test was added separately. No conflicts occurred. After the review correction, the Engine guard and policy test were transferred from the isolated source. The four P4 files now match the isolated source by SHA-256. No main Engine file was replaced wholesale; all Windows Verification changes remain present.

## Focused regression and hygiene

- Isolated P4.1 source: `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/workflow-judge-policy.test.mjs` — **14/14 passed**, exit 0, after the correction.
- Combined main candidate: same P4.1 command — **14/14 passed**, exit 0.
- Combined main candidate after the retry guard: `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/linked-repair-isolation.test.mjs runtime/tests/parent-repair-coordination.test.mjs` — **28/28 passed**, exit 0.
- A broader selected combined-candidate regression had previously passed **412/412** before the final retry guard. The current P4 and linked-repair suites above were rerun after that guard; the Windows source files were not changed by the correction.
- `npm run docs:check` — passed with zero errors (32 schemas; 141 positive schema cases; 82 negative schema cases; 42 negative semantic cases; 1,259 local links).
- `node --check` for modified JavaScript modules and JSON parsing for the workflow schema — passed.
- `git diff --check` — passed. Git reported existing LF-to-CRLF warnings for Windows-modified files; no whitespace errors were reported.

## Independent review

A fresh read-only review first reported the linked-repair recovery blocker above. After the correction, the reviewer re-read the combined candidate and returned **Pass; prior finding closed; no blocking issue**. The second pass verified the retry refusal rolls back the P2 transaction, startup leaves the P4 Parent interrupted, and the P4 link and history remain intact. It also rechecked direct/API/Host admission, Judge targeting, legacy role compatibility, publication identity, custody handling, Windows change preservation and scope. No files were edited and no tests were run by the reviewer.

## Remaining limitations

P4.1 validates and publishes the policy but deliberately refuses all new Runs using it until P4.2. Durable Judge attention, Judge-only scheduling and execution, Judge decision authority, native Judge Custody recovery, human questions and adaptive Repair approval remain unimplemented. The refusal is temporary and centralized so P4.2 can replace it with native admission.

## Git inventory

At completion, no files are staged. No commits, pushes, merges, rebases, resets or cleanup operations were performed. The main branch and HEAD are unchanged. Historical stashes, Windows Verification edits, review documents and other pre-existing user changes remain in place.
