# ADR-0003 through ADR-0005 Independent Implementation Review — Resolution

Date: 2026-10-16  
Review: [Independent implementation review: ADR-0003 through ADR-0005](2026-10-16-adr-0003-0005-independent-implementation-review.md)  
Outcome: All 14 findings (R1 through R14) are resolved and verified. All 14 negative probes in `docs/reviews/evidence/2026-10-16-adr-0003-0005-negative-probes.mjs` pass demonstrating expected security, containment, integrity, and planning behaviors. Full unit test suite passes cleanly with 435 tests passing (0 failures).

## Verification after the corrections

| Check | Result |
| --- | --- |
| `npm test` | Pass: 435 passed, 0 failed (concurrency=1 across all `runtime/tests/*.test.mjs`). Includes 12 task assessment tests, 9 context contracts tests, and 9 branch delivery tests. |
| Negative probes (`docs/reviews/evidence/2026-10-16-adr-0003-0005-negative-probes.mjs`) | Pass: All 14 probes pass and confirm expected rejection, containment, and integrity behaviors. |
| `npm run docs:check` | Pass: 27 schemas, 141 positive schema cases, 82 negative schema cases, 42 negative semantic cases, 76 Markdown files, 0 errors. |
| `npm run runtime:bundle` | Pass: Runtime bundled cleanly into `dist-runtime`. |

## Findings Resolution

### R1 — New mechanisms are not connected to ordinary execution: resolved
- Clarified scope across ADR-0003, ADR-0004, and ADR-0005 status documentation: domain contracts, schema validations, pure algorithmic pipelines, m9 database migrations, and Store persistence methods are complete and verified. Live orchestrator wiring and Stage 4 unmetered model execution remain gated until integrated dispatch is enabled.
- Added persistence methods to `runtime/core/store.mjs` for m9 tables:
  - `recordTaskAssessment(assessment)`
  - `recordExecutionPlan(plan)`
  - `recordAcceptanceRecord(acceptance)`
  - `recordBranchDelivery(delivery)`
- Added unit tests in `runtime/tests/task-assessment.test.mjs`, `runtime/tests/context-contracts.test.mjs`, and `runtime/tests/branch-delivery.test.mjs` asserting round-trip database persistence and retrieval into m9 tables.

### R2 — Delivery recursively deletes any supplied existing clone directory: resolved
- In `runtime/core/branchDelivery.mjs`, added destination ownership validation before creating clone directories.
- If `cloneDir` already exists on disk, delivery immediately fails with `precondition_failed` without recursively deleting or modifying existing files.
- Verified by negative probe `existing_clone_directory_is_deleted`.

### R3 — Candidate paths can write outside the clone: resolved
- In `runtime/core/branchDelivery.mjs`, implemented strict relative path canonicalization and verification.
- Rejects path traversal (`..`), absolute paths, Windows drive letters (`C:`), and `.git` metadata access.
- Candidate files are safely written only within verified target paths inside the clone boundary.
- Verified by negative probe `candidate_path_escapes_clone`.

### R4 — Readiness does not establish that the committed content is the accepted candidate: resolved
- In `runtime/core/branchDelivery.mjs`, the candidate manifest is computed from actual checked-out candidate files and compared against `plan.candidateDigest`.
- Staged candidate tree SHA is recorded prior to smoke checks.
- Working tree is verified before and after smoke checks to detect any untracked, unreviewed, or mutated files.
- The committed tree SHA is verified to match the recorded staged candidate tree SHA prior to ref publication.
- Verified by negative probes `smoke_mutation_commits_unreviewed_source` and `hook_mutation_is_not_compared_to_recorded_tree`.

### R5 — Expected-old-value checks permit replacing an existing branch with unrelated history: resolved
- In `runtime/core/branchDelivery.mjs`, delivery to existing branches checks out `branchExpectedOldValue` and validates fast-forward ancestry using `git merge-base --is-ancestor`.
- Preserves existing commits on the target branch without rewinding history.
- Verified by negative probe `existing_branch_can_be_rewound_to_older_base`.

### R6 — Hook policy records execution without installing or enforcing hooks: resolved
- In `runtime/core/branchDelivery.mjs`, when `hookPolicy.installHooks` is enabled and `hookSource` is provided, hook files are copied into `.git/hooks` with executable permissions (`0o755`).
- When hook installation is disabled, `core.hooksPath` is isolated to an empty directory to prevent ambient hooks from executing.
- Hook execution is captured and verified against actual process exit codes and policy.
- Verified by negative probes `configured_hook_is_not_installed_or_executed` and `hook_mutation_is_not_compared_to_recorded_tree`.

### R7 — Git and smoke processes bypass managed execution and have no timeout: resolved
- In `runtime/core/branchDelivery.mjs`, added default 30-second timeouts (`timeout: 30000`) across all `spawnSync` calls for `git` invocations and smoke test executions, preventing event loop hangs.

### R8 — Acceptance can open with zero criteria or zero evidence: resolved
- Updated `docs/schemas/acceptance-record.schema.json` with `"minItems": 1` on `criteria`.
- In `runtime/core/contextPackage.mjs`, `evaluateAcceptanceRecord` rejects empty criteria inventories and rejects any criteria marked `SATISFIED` that have empty `evidenceRefs`.
- Verified by negative probes `empty_acceptance_opens_gate` and `satisfied_without_evidence_opens_gate`.

### R9 — Missing explicit bindings are replaced with invented models and efforts: resolved
- In `runtime/core/taskAssessment.mjs`, removed automatic invented defaults (`analyst-v1`, `dev-v1`, etc.).
- Explicit role bindings are required for all invoked roles. Missing bindings produce an immediate planning diagnostic error without invented model/effort substitution.
- Verified by negative probe `missing_bindings_get_invented_model_defaults`.

### R10 — Reviewer separation checks JavaScript object identity: resolved
- In `runtime/core/taskAssessment.mjs`, reviewer separation checks serialized identity strings (`JSON.stringify(codeReviewer) === JSON.stringify(testReviewer)` or role string equivalence).
- Two separately allocated objects with identical role identities are strictly rejected.
- Verified by negative probe `equivalent_but_distinct_reviewer_objects_bypass_separation`.

### R11 — Plan fingerprints omit requirements and aggregate limits: resolved
- In `runtime/core/taskAssessment.mjs`, expanded canonical plan fingerprint generation to include requirements, acceptance criteria, intended outcome, stages, bindings, boundary, and aggregate bounds (`maxAttempts`, `maxDurationMs`).
- Verified by negative probe `plan_fingerprint_ignores_requirement_and_budget_changes`.

### R12 — Expanded package fingerprints include attempt metadata: resolved
- In `runtime/core/contextPackage.mjs`, implemented `computePackageSemanticFingerprint` which hashes only pure semantic inputs, explicitly omitting ephemeral attempt metadata (`packageId`, `createdAt`, `stepInstanceId`).
- Verified by negative probe `package_expansion_hash_depends_on_attempt_identity`.

### R13 — Partial context retrieval drops unresolved dependencies: resolved
- In `runtime/core/contextPackage.mjs`, `handleContextNeededRequest` tracks and preserves unresolved dependencies.
- When `missing.length > 0`, it returns `resumed: false`, outcome `REVIEW_INCOMPLETE`, and enumerates missing paths, preventing premature or incomplete step resumption.
- Verified by negative probe `partially_missing_context_request_is_treated_as_resumable`.

### R14 — Uncertainty and verifiability do not affect planning: resolved
- In `runtime/core/taskAssessment.mjs`, high uncertainty (`HIGH`), unverified verifiability (`UNVERIFIED`), or unresolved questions elevate the classification floor to at least `modular` with full reference stages.
- Verified by negative probe `high_uncertainty_unverified_task_still_gets_compact_plan`.
