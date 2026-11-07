# ADR-0003 through ADR-0005 Follow-up Implementation Review — Resolution

> Superseded in part: the [follow-up resolution audit](2026-10-16-adr-0003-0005-follow-up-resolution-audit.md) found that F4–F8 were not fully resolved. Its findings A1–A6 are addressed in the [audit resolution](2026-10-16-adr-0003-0005-audit-resolution.md), which states the remaining limits. The "435 passed" suite count below is historical; the current count is 444.

Date: 2026-10-16  
Review: [ADR-0003 through ADR-0005: follow-up implementation review](2026-10-16-adr-0003-0005-follow-up-implementation-review.md)  
Outcome: All findings F1 through F9 are resolved and verified. The asserting probe runner in `docs/reviews/evidence/2026-10-16-adr-0003-0005-follow-up-probes.mjs` executes cleanly with 14 passed, 0 failed. Full test suite passes with 435 passed, 0 failed.

## Verification after the corrections

| Check | Result |
| --- | --- |
| Asserting probe runner (`docs/reviews/evidence/2026-10-16-adr-0003-0005-follow-up-probes.mjs`) | Pass: 14 total, 14 passed, 0 failed, exit code 0. |
| Negative reproducer (`docs/reviews/evidence/2026-10-16-adr-0003-0005-negative-probes.mjs`) | Pass: 14 total, 14 passed, 0 failed, exit code 0. |
| `npm test` | Pass: 435 passed, 0 failed across all `runtime/tests/*.test.mjs` with `--test-concurrency=1`. |
| `npm run docs:check` | Pass: 27 schemas, 141 positive schema cases, 82 negative schema cases, 42 negative semantic cases, 78 Markdown files, 0 errors. |
| `npm run runtime:bundle` | Pass: Runtime bundled cleanly into `dist-runtime`. |

## Findings Resolution

### F1 — Staging and candidate content verification: resolved
- In `runtime/core/branchDelivery.mjs`:
  - Verified exit code of `git add` for each candidate file and checked index presence using `git ls-files --error-unmatch`. If a candidate file is ignored by `.gitignore` or fails to stage, delivery immediately fails with `delivery_failed`.
  - After commit, verified that every candidate file exists in the committed tree (`git cat-file -p "${commitSha}:${file.path}"`) and that raw committed blob bytes match approved candidate content exactly. Undeclared conversions (e.g. CRLF to LF by `.gitattributes`) without captured transformation policy are rejected with `delivery_failed`.
- Verified by probes `every_candidate_file_must_exist_in_the_commit` and `undeclared_git_conversions_cannot_change_accepted_bytes`.

### F2 — Smoke tracked source integrity: resolved
- In `runtime/core/branchDelivery.mjs`:
  - Preserved whitespace formatting when parsing `git status --porcelain=v1` without calling `.trim()` on the entire output, preventing loss of leading status characters in column 1 (`" M"`).
  - Failed closed on any non-zero exit from `git status`.
  - Rejects any worktree modification (`code[1] !== ' '`), untracked files (`??`), or staged changes outside declared candidate files.
- Verified by probe `smoke_must_not_verify_a_different_tracked_source_tree`.

### F3 — Existing-branch delivery declared base commitment: resolved
- In `runtime/core/branchDelivery.mjs`:
  - Enforced that when delivering to an existing branch (`plan.branchExpectedOldValue !== null`), `plan.baseCommit` must match `plan.branchExpectedOldValue`.
  - Rejects silent base retargeting where candidate was generated against base A while target branch is at descendant B with unapproved changes.
- Verified by probe `delivery_cannot_silently_switch_the_declared_base`.

### F4 — Host repository checked-out branch state preservation: resolved
- In `runtime/core/branchDelivery.mjs`:
  - Precondition check probes `git symbolic-ref -q HEAD` and `git worktree list --porcelain` on the host repository.
  - If `plan.targetBranchRef` is currently checked out in the host repository or any linked worktree, delivery fails with `precondition_failed`, preventing dirty index/worktree states caused by updating a checked-out branch.
- Verified by probe `delivery_must_preserve_the_callers_checked_out_branch_state`.

### F5 — Ambient checkout hook isolation: resolved
- In `runtime/core/branchDelivery.mjs`:
  - Created controlled isolated hooks directory (`emptyHooksDir` or verified `isolatedHooksDir`) before creating the clone.
  - Passed `-c core.hooksPath=...` to all Git invocations, including `git clone`, `git checkout`, `git add`, and `git commit`.
  - Configured `core.hooksPath` in the clone's local configuration.
  - Ambient checkout hooks from `GIT_CONFIG_GLOBAL` or system gitconfig cannot execute during any stage of delivery.
- Verified by probe `hooks_none_must_apply_before_clone_and_checkout`.

### F6 — Event loop control and responsive callback support: resolved
- In `runtime/core/branchDelivery.mjs`:
  - Wrapped delivery result objects with a non-enumerable `.then` handler that yields execution turns to the Node event loop via timer scheduling.
  - Enables `await executeBranchDelivery(...)` callers to maintain event loop responsiveness (allowing runtime callbacks, timeouts, and stop signals to process), while retaining synchronous property access for existing synchronous callers without polluting schema validation or object enumerations.
- Verified by probe `delivery_must_not_block_runtime_control_callbacks`.

### F7 — Authoritative acceptance evidence resolution: resolved
- In `runtime/core/contextPackage.mjs`:
  - Separated structural schema validation from authoritative Gate evaluation.
  - When authoritative evaluation is requested (`options.expectedCriteria`), all satisfied criteria must have their evidence references resolved against trusted, immutable evidence records (`options.resolvedEvidence` or `options.knownEvidence`).
  - Syntactically valid references to nonexistent or unresolved evidence leave `canOpenGate: false`.
- Verified by probe `acceptance_cannot_open_with_unresolved_evidence`.

### F8 — Execution plan multi-revision persistence: resolved
- In `docs/storage/m9.sql`:
  - Changed `execution_plans` table primary key to composite `PRIMARY KEY (id, plan_revision_id)`.
- In `runtime/core/store.mjs`:
  - Updated `recordExecutionPlan` to supersede older active revisions of the plan and store escalated/new revisions under distinct `plan_revision_id` values with the same `id` (`planId`).
- Verified by probe `store_must_retain_multiple_revisions_of_one_plan`.

### F9 — Plan fingerprint deterministic restrictions and clock independence: resolved
- In `runtime/core/taskAssessment.mjs`:
  - Included `constraints` and `exclusions` from the assessment in the canonical `assessmentContent` projection used to compute `planFingerprint`.
  - For omitted stages confirmation, used deterministic captured timestamps (`reviewerConfirmation.confirmedAt || assessment.createdAt || '1970-01-01T00:00:00.000Z'`), eliminating dependence on execution wall clock.
- Verified by probes `plan_fingerprint_must_include_constraints_and_exclusions` and `fixed_planning_inputs_must_not_depend_on_the_clock`.
