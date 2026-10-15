# Fourth Review: Verification of the v0.8 Resolution

Reviewed: 2026-10-13
Subject: [2026-10-13-third-review-resolution.md](2026-10-13-third-review-resolution.md) and the files changed with it: M1_CONTRACTS, LOOPS, MILESTONES, README, RUN_HISTORY_AND_REPLAY, the API and journal schemas, the M1 DDL, the decision/invalid/SQL/manifest fixtures, and the validator.
Previous: [third review](2026-10-13-third-review.md)

**Verdict: resolved, with no new findings.** The M1 contract package has no remaining known blockers. Implementation still requires the user's explicit authorization.

## 1. The §2.1 finding (`waiting_for_user` unreachable)

The resolution chose option (a): remove the state from M1. I checked each claim:

| Claim | Evidence |
| --- | --- |
| Removed from the M1 lifecycle | The M1_CONTRACTS transition table has no row for it. The text states "exactly eight run states", and the count is correct: queued, running, draining, stopping, succeeded, failed, canceled, interrupted. Root Stop applies to `queued/running/draining`. |
| Removed from every enum | A repository-wide search, excluding the historical reviews, finds the literal only in rejection fixtures and in reservation notes in LOOPS, MILESTONES, M1_CONTRACTS, RUN_HISTORY, and README. It is absent from the API schema, journal schema, DDL CHECK, and active-run index. |
| Precedence defined | When one failed attempt produces both outcomes, the failure governs the run (`draining` → `failed`) and `needs_review` stays on the binding. Stop and restart keep their outcomes. Acknowledgement affects only later runs and never reopens or un-drains a run. |
| Entry cases closed | Continuing from a binding that isn't ready is rejected with 422 `context_unavailable` and no run is created. A binding that becomes unusable at dispatch makes the planned attempt fail before any CLI launch, and the run then drains normally. Both cases exist in `fixtures/decisions.json`. |
| Deferred correctly | MILESTONES lists "reachable waiting_for_user lifecycle/precedence and its versioned API/event/DDL extension" as an M2 prerequisite. LOOPS §Failure and recovery records the reservation. |
| Regression fixtures | Five schema rejections cover the run, stop, and filter payloads and both sides of a journal transition. The SQL cases reject the state, keep `needs_review` alongside a failed run, and allow a new run after the old one finishes. A positive case keeps `needs_review` valid for bindings. |

## 2. Reproduced validation

`npm.cmd run docs:check` returned `errors: []`. Every count matches the resolution note:

- 10 schemas
- 58 valid / 30 structural / 14 semantic cases
- 25 decision cases
- 29 SQL cases across 13 tables
- 245 links across 25 Markdown files

The validator still imports no networking module, writes no files, and installs nothing.

## 3. Status

| Area | Status |
| --- | --- |
| Findings from reviews 1–3 | All resolved and verified |
| New findings | None |
| Implementation hints (third review §2.2) | Still apply as guidance for the M1 implementation (suspended Node launch via `CreateProcessW`, Job drain before close, backpressure vs. timeout classification, Python oracle vs. Node validator) |
| M2–M6 | Contract prerequisites listed in MILESTONES, as intended |
| M1 readiness | The contract package is complete; implementation awaits the user's explicit authorization |
