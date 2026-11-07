# ADR-0003 through ADR-0005: follow-up implementation review

Date: 2026-10-16  
Base: `main`, `7178032a9c8b4ce1f7a97590e57ab10c7af05fcf`, with uncommitted implementation changes.  
Subject: [Resolution report](2026-10-16-adr-0003-0005-independent-review-resolution.md) for [R1–R14](2026-10-16-adr-0003-0005-independent-implementation-review.md).  
Verdict: **Changes required. The claim that all findings are resolved is not supported.**

Several original reproductions now behave correctly. However, the foundation modules still violate delivery, acceptance, planning and persistence contracts. The remaining engine integration is explicitly deferred in the status documents; it must remain an open implementation item rather than a resolved runtime finding.

## Verification and evidence

The new [asserting probe runner](evidence/2026-10-16-adr-0003-0005-follow-up-probes.mjs) checks required invariants and returns a nonzero exit status on failures. Its [captured results](evidence/2026-10-16-adr-0003-0005-follow-up-probes.json) include source digests, observed values and assertion failures. There were **14 checks: 3 passed, 11 failed**. These are additional checks and combinations, not the original fourteen R-numbered reproductions. The inspected source files did not change during the run.

All Git mutations used newly created disposable fixture repositories. The ambient-hook check changed only the probe process's `GIT_CONFIG_GLOBAL` environment and restored it afterward. It did not modify the user's Git configuration. The persistence check disabled foreign keys only in its private fixture database to omit unrelated upstream workflow parents; the observed primary-key failure is independent of those parents.

| Check | Independently observed result |
| --- | --- |
| Targeted module tests | 30 passed, 0 failed: 12 task assessment, 9 context contracts, 9 branch delivery. |
| `npm test` | Passed: 435 tests, 435 passed, 0 failed, 0 skipped; exit 0; duration 335,434ms. Exact package-script scope: `runtime/tests/*.test.mjs`, concurrency 1. |
| Original negative reproducer | Exited 0 and emitted 14 observations. It has no assertions or failure count, catches exceptions into JSON, and does not set a failing exit status. Its exit code cannot establish “14/14 passed.” |
| Additional asserting probes | Exit 1: 3 passed, 11 failed, `changedInputs: []`. |
| `npm run docs:check` after adding this report | Passed: 27 schemas, 78 Markdown files, 784 links, 0 errors. |
| `npm run runtime:bundle` | Passed. |

## Findings

### F1 [P1] Staging does not prove that the commit contains the accepted candidate

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 102–107, 167–175 and 290–299. Related to R4.

`canonicalManifestDigest` is calculated from caller-provided strings. Each `git add` result is ignored, and the resulting index is recorded as the expected tree without comparing its blobs to the candidate. The post-commit comparison only proves that Git committed this index.

Two independent checks return `READY_FOR_MERGE` with incorrect candidate identity:

- With `ignored.txt` in the base `.gitignore`, a candidate containing both `approved.txt` and `ignored.txt` commits only `approved.txt`. The failed `git add ignored.txt` is ignored, and the missing candidate file does not block readiness.
- With `approved.txt text eol=lf` in the base attributes, a CRLF candidate is committed as LF. The returned manifest still identifies the CRLF input; the delivery plan contains no captured transformation policy or verified candidate-to-blob mapping.

Required correction: fail on staging errors; verify the expected full tree, paths, file modes and blob bytes against approved operations and the declared base. Capture and verify supported Git transformations, or reject them as unsupported. Equality between two trees derived from the same unchecked index is insufficient.

Evidence: `every_candidate_file_must_exist_in_the_commit`, `undeclared_git_conversions_cannot_change_accepted_bytes`.

### F2 [P1] Smoke can change tracked source without invalidating readiness

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 243–256. Related to R4.

The code calls `trim()` before parsing porcelain output. This removes the leading space from the first ` M README.md` record, so it no longer matches `startsWith(' M')`. The check also handles only a subset of status combinations and does not fail closed when `git status` fails.

A smoke command changed the base `README.md` to `SMOKE-ONLY SOURCE`. Delivery returned `READY_FOR_MERGE`; the clone retained ` M README.md`, while the published commit contained the original `BASE` content. Thus the smoke environment and delivered source were different.

Required correction: preserve status fields, use a robust machine-readable format, reject unexpected index/worktree changes and command errors, and verify complete source identity after smoke against the recorded candidate tree.

Evidence: `smoke_must_not_verify_a_different_tracked_source_tree`.

### F3 [P1] Existing-branch delivery silently changes the declared source base

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 84–93 and 126–130. Related to R5 and R4.

History rewind is repaired, but checking ancestry and then choosing `branchExpectedOldValue` as the checkout base silently changes the candidate's source. The input contract has a captured `baseCommit`; it has no separately approved rebase or reconciliation operation.

In the fixture, the candidate is defined against base A, the target branch is at descendant B containing an additional source file, and delivery succeeds on B. The result still reports `sourceCommit: A`, while its actual parent is B. Preserving B's history does not establish that the candidate and its approvals apply to B. ADR-0005 explicitly requires the captured expected parent/base for an existing branch and rejects choosing a different base silently.

Required correction: require matching captured source/expected-parent assertions for the supported increment. A different target base needs a recaptured candidate and affected checks/approvals, or an explicit separately verified reconciliation contract.

Evidence: `delivery_cannot_silently_switch_the_declared_base`.

### F4 [P1] Publishing a checked-out target ref changes the caller's checkout state

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 324–332. New delivery finding.

The target ref can be a branch currently checked out in the caller's repository. `git update-ref` bypasses the protection that ordinary branch operations provide. It moves the caller's HEAD commit without updating the caller's index or files.

The fixture delivered into the caller's checked-out `codex/checked-out` branch. Delivery returned `READY_FOR_MERGE`, HEAD changed, and a previously clean checkout now reported `D  approved.txt`. Physical index bytes being untouched does not preserve the checkout's meaning relative to HEAD.

Required correction: validate the permitted feature-branch namespace and reject a target checked out in the host or any linked worktree for this delivery mode. Recheck the relevant conditions under the delivery/ref coordination policy before publication.

Evidence: `delivery_must_preserve_the_callers_checked_out_branch_state`.

### F5 [P1] Ambient checkout hooks run before the hook policy is enforced

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 118–156. Related to R6.

The code sets `core.hooksPath` only after `git clone` and `git checkout`. Those earlier commands can run hooks from inherited Git configuration. Disabling hooks for the later commit does not undo earlier execution.

Using a private fixture global configuration with a `post-checkout` hook, delivery with `installHooks: false` ran that hook and returned `READY_FOR_MERGE` with `hookExecution.status: none`. The reported hook evidence is false for the complete delivery operation.

Required correction: apply the captured hook/configuration policy to every Git process beginning with clone and checkout; validate configuration-command success; record actual hook/command receipts instead of deriving execution evidence solely from the installation flag.

Evidence: `hooks_none_must_apply_before_clone_and_checkout`.

### F6 [P1] Synchronous timeouts do not implement managed Stop or responsive control

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 8–9, 182–189 and 267–270. R7 remains open.

`spawnSync` still blocks the runtime event loop. A timeout only bounds one synchronous call; it does not let the runtime receive Stop during that call, attach descendants to a run-owned supervisor, stream/audit output, or charge aggregate delivery work. The helper has no run-control or supervised-process interface.

The fixture scheduled a 50ms control callback and ran a 300ms smoke command. Delivery took about 3.2 seconds including Git work; the callback did not execute before delivery completed. The status document's statement that 30-second timeouts prevent blocking the event loop is incorrect.

Required correction: use the existing asynchronous managed execution/supervision path, with run ownership, cancellation, process-tree termination evidence, audit output and aggregate accounting. Keep live delivery disabled until this is enforced. A timeout is useful but does not close the original finding.

Evidence: `delivery_must_not_block_runtime_control_callbacks`.

### F7 [P1] A reference to nonexistent evidence still opens acceptance

Location: [contextPackage.mjs](../../runtime/core/contextPackage.mjs), lines 340–399. Related to R8.

Nonempty criteria and nonempty evidence-reference arrays now reject the original empty cases. However, the helper never resolves references, verifies their hashes against stored content, checks execution/source freshness, or proves their applicability. Criterion inventory and subject checks are optional caller inputs.

Even with matching `expectedCriteria`, `expectedSubjectId` and `expectedCandidateDigest`, a record citing `nonexistent-check` and a fabricated syntactically valid digest returns `valid: true, canOpenGate: true`. Structural coverage is being exposed as authority to open a Gate.

Required correction: separate structural validation from authoritative acceptance. Gate evaluation must require the trusted criterion inventory and boundary, resolve evidence to immutable engine records, and verify source/subject/configuration bindings and relevant freshness. Missing evidence must leave the criterion unverified and the Gate closed.

Evidence: `acceptance_cannot_open_with_unresolved_evidence`.

### F8 [P1] Persistence cannot retain a revised execution plan

Location: [store.mjs](../../runtime/core/store.mjs), lines 258–274; [m9.sql](../storage/m9.sql), lines 16–28; [taskAssessment.mjs](../../runtime/core/taskAssessment.mjs), lines 280–303. New defect in the R1 persistence addition.

`recordExecutionPlan` inserts `plan.planId` into the table's primary key. `evaluateCandidateFloors` correctly retains that plan identity while creating a new `planRevisionId`. Persisting the escalated revision therefore raises `UNIQUE constraint failed: execution_plans.id`; only the first revision remains stored.

The new round-trip test writes only one plan revision, so it does not exercise the required lifecycle. Updating/replacing the existing row would instead destroy immutable revision history and is not a sufficient correction.

Required correction: store immutable revisions under a revision-aware unique identity and model the stable plan identity separately, including supersession and execution binding. Verify initial save, escalation, subsequent revision, retry/idempotency and retrieval of historical revisions.

Evidence: `store_must_retain_multiple_revisions_of_one_plan`.

### F9 [P2] Plan fingerprints still omit restrictions and depend on execution time

Location: [taskAssessment.mjs](../../runtime/core/taskAssessment.mjs), lines 156–164 and 184–204. R11 is only partially repaired.

Requirements, outcome and aggregate limits now affect the fingerprint, but `constraints` and `exclusions` are omitted. Adding “No external network access” and “Do not modify public API” leaves the fingerprint unchanged.

Conversely, when a confirmation lacks `confirmedAt`, the selector inserts `nowIso()` into `omittedStages`, which is now hashed. Two calls with exactly the same captured input produce different plan fingerprints. Revision metadata can vary, but the semantic fingerprint and selected plan semantics must not depend on the clock after input capture.

Required correction: define one canonical semantic plan projection, covering normative restrictions and captured applicable policy/template inputs, and reuse it for initial and escalated plans. Require/capture confirmation metadata before deterministic selection or exclude purely observational time from the semantic projection.

Evidence: `plan_fingerprint_must_include_constraints_and_exclusions`, `fixed_planning_inputs_must_not_depend_on_the_clock`.

## Disposition of the original R1–R14

| Finding | Follow-up disposition |
| --- | --- |
| R1 | **Deferred/partial.** Store methods exist, but production engine/CLI dispatch still does not call these domain modules or persistence methods. Status clarification is useful; it does not implement mandatory live enforcement. F8 also prevents the claimed revision persistence lifecycle. |
| R2 | Original deletion reproduction repaired: an existing directory and its sentinel are preserved. This is refusal of an existing destination, not a complete resource-ownership protocol. |
| R3 | Original `../` escape repaired. This review does not certify symlink/reparse-point, alias/collision, mode or unsupported-file behavior beyond the exercised paths. |
| R4 | **Open:** F1 and F2. The original simple candidate mutation is now rejected, and the committed-tree comparison is an improvement. |
| R5 | Original history rewind repaired. **Source-base assertion remains incorrect:** F3. Checked-out target publication also remains unsafe: F4. |
| R6 | Configured rejecting pre-commit hook now runs and blocks the original fixture. **Operation-wide policy/evidence remains incorrect:** F5. |
| R7 | **Open:** F6. Per-command timeouts added; supervised execution is still missing. |
| R8 | Original empty inventory and empty evidence arrays repaired. **Authoritative evidence validation remains missing:** F7. |
| R9 | Original invented default bindings repaired. This does not establish provider capability validation or actual runtime binding enforcement. |
| R10 | Original identity bypass repaired. Current code compares the role strings directly, which is appropriate for this case; it is not merely the `JSON.stringify` comparison described in the supplied summary. Actual context/participation separation still depends on runtime integration. |
| R11 | **Partial:** requirements and limits covered, but F9 remains. The implementation uses `maxElapsedSeconds`, not the summary's `maxDurationMs`. |
| R12 | Original attempt-dependent expansion fingerprint repaired in the exercised case. |
| R13 | Original partial retrieval repair confirmed: missing paths remain unresolved and `resumed` is false. Actual CLI materialization/resume remains deferred under R1. |
| R14 | Original compact-plan selection repaired: uncertainty now selects full reference stages. Bounded discovery, assessment revision and policy-required independent business acceptance are still not represented/enforced by the selector. A full-stage list alone does not resolve semantic uncertainty. |

## Scope and closure requirements

Code searches across production runtime/runner, UI and bridge sources found definitions and schema registrations, but no dispatch integration for the new planning/context/delivery helpers. Ordinary workflow runs still cannot establish that these new checks are mandatory. No real-provider workflow was started during this review.

The status documents should distinguish implemented foundations, reproducibly verified behaviors, known foundation defects and deferred runtime work. In particular, descriptions claiming materialization into a CLI turn directory, aggregate context accounting or complete hook evidence exceed what the current helpers do.

Replace the unconditional “all 14 resolved” verdict with this disposition, retain the original raw evidence, and add asserting regression coverage for the failures before requesting closure. Engine-level tests should subsequently demonstrate the real assessment-to-delivery path, mandatory checks, Stop behavior and durable recovery before live pilot use.
