# ADR-0003 through ADR-0005: audit of the follow-up resolution

Date: 2026-10-16  
Subject: [Follow-up resolution report](2026-10-16-adr-0003-0005-follow-up-review-resolution.md).  
Checkout: `main`, `7178032a9c8b4ce1f7a97590e57ab10c7af05fcf`, with uncommitted implementation changes.  
Verdict: **Changes required. Passing the previous probes does not establish closure of F1–F9.**

## Verification

- The previous asserting follow-up probes were rerun unchanged: **14 passed, 0 failed**, exit 0. The input source digests were unchanged during that run. Results: [post-resolution rerun](evidence/2026-10-16-adr-0003-0005-follow-up-probes-after-resolution.json).
- The three module test files were rerun: **30 passed, 0 failed**, exit 0. The full 435-test suite was not repeated in this audit; the resolution report's full-suite result is not an independently repeated result here.
- Additional assertions for execution ordering, authoritative evidence and failure/retry/upgrade behavior: **8 failed**, exit 1, with no source drift. See [runner](evidence/2026-10-16-adr-0003-0005-resolution-audit-probes.mjs) and [captured observations](evidence/2026-10-16-adr-0003-0005-resolution-audit-probes.json).
- `npm run docs:check`: passed with 27 schemas, 80 Markdown files, 796 local links and no errors after adding this audit.
- `npm run runtime:bundle`: passed.

All Git side effects and database mutations in this audit used newly created fixture repositories and stores. No live provider workflow or delivery against the user's repository was executed. No implementation fixes were made by this audit.

## A1 [P1] F6 is still open: the thenable yields only after delivery has finished

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 10–30, 262–269, 368–372 and 456–510.

`wrapResult` adds a non-enumerable `.then` which waits 60ms before resolving an already completed result. Git, smoke, commit and target-ref publication still execute synchronously before `executeBranchDelivery` returns. The wrapper does not allow the runtime to handle callbacks during those operations, implement run-owned cancellation or supervise child processes.

The earlier probe was insufficient: it checked only that a 50ms callback had run by the time `await` completed. A 60ms delay after all delivery side effects satisfies that assertion. This audit strengthens the check to require the callback before smoke completion and ref publication.

Observed: the function blocked synchronously for 2,095ms; the target ref existed before awaiting its returned thenable; the callback ran after smoke ended and saw the branch already published. The delivered result was `READY_FOR_MERGE`.

Required correction: remove the result-delay workaround and implement genuinely asynchronous execution through the existing run-owned process/supervision path, including cancellation, descendant termination, output capture and aggregate accounting. Verify control while smoke is still running and verify that Stop prevents subsequent publication.

Probe: `control_callback_must_run_before_smoke_ends_and_ref_is_published`.

## A2 [P1] F7 is still open: structural and weak evidence inputs can authorize acceptance

Location: [contextPackage.mjs](../../runtime/core/contextPackage.mjs), lines 320–347, 409–449.

Evidence resolution runs only when `options.expectedCriteria` is an array. Calling the default evaluator with no trusted inventory or resolved evidence still returns `canOpenGate: true`. Thus structural validation has not actually been separated from authority to open a Gate.

Even in the authoritative branch:

- A `Set` containing only an evidence ID is enough to accept an arbitrary supplied digest.
- A `Map` entry with a matching ID/digest is accepted regardless of its kind, subject, candidate or execution outcome. The fixture supplied a failed artifact from another candidate/subject as evidence for a successful current check, and the Gate still opened.

These checks demonstrate missing prerequisite validation, not an attempt to have the runtime infer semantic evidence quality automatically.

Required correction: a structural-only result must not open a Gate. Authoritative evaluation must require the captured criterion inventory and boundary, resolve complete immutable engine records under a strict contract, and verify kind, digest, applicability, subject/source and the criterion's required execution outcome. Reject ID-only and incomplete records. Do not infer trust merely from a caller's collection name.

Probes: `structural_validation_without_trusted_inputs_cannot_open_gate`, `evidence_id_membership_cannot_replace_digest_verification`, `resolved_evidence_must_match_kind_source_and_success`.

## A3 [P1] F5 is only partially fixed: host ref hooks still execute under hooks:none

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 449–456.

The clone/checkout hook override fixes the earlier ambient checkout scenario. However, the final host `fetch` and `update-ref` still use the ordinary `git` helper without the hook-policy override. Contrary to the resolution text, the override is not applied to every Git invocation.

A host fixture's `reference-transaction` hook ran during publication while delivery returned `READY_FOR_MERGE` and `hookExecution.status: none`. Its marker recorded two executions. The host hook was created only in the disposable fixture repository.

Required correction: enforce the captured hook/configuration policy for host-side Git operations as well, or return an explicit unsupported/precondition result when host policy cannot be reconciled. Keep hook receipts accurate for the complete operation.

Probe: `hooks_none_must_also_cover_host_ref_publication`.

## A4 [P1] F8 persistence is not atomic on retry or failure

Location: [store.mjs](../../runtime/core/store.mjs), lines 258–277.

The composite key permits two distinct revisions in a fresh database. But `recordExecutionPlan` first commits `UPDATE ... status = 'superseded'` and then performs the new revision `INSERT` outside a surrounding transaction. Retrying the same immutable revision causes the insert to fail with the composite-key uniqueness error after the active version has already been superseded.

Observed: a single saved active revision became `superseded` after a rejected identical retry, leaving **zero active revisions**. The failed operation changed valid state without installing a replacement. Foreign keys were disabled only in this private fixture to omit unrelated upstream workflow parents; the uniqueness failure and supersession bug do not depend on foreign-key enforcement.

Required correction: make revision insertion and supersession atomic and idempotent using the store's transaction facility. An identical retry should return its original receipt; a conflicting or failed insert must preserve the previous active revision. Verify rollback and retry behavior, not only two successful inserts.

Probe: `failed_revision_retry_must_preserve_the_active_revision`.

## A5 [P1] F8 does not upgrade a store that already applied the earlier m9

Location: [m9.sql](../storage/m9.sql), lines 16–28; [store.mjs](../../runtime/core/store.mjs), lines 61–76.

The schema change edits migration 9 in place. `Store.migrate` selects unapplied migrations by version; a database already at version 9 does not execute the edited migration again. There is no later upgrade step for its old primary key.

The audit created an empty fixture store using the previous m9 definition, closed it, then reopened it with the current runtime. The version stayed 9 and `execution_plans` still had only `id` as its primary key. That store continues to reject a second revision, despite fresh-store probes passing.

Required correction: provide an append-only upgrade preserving prior rows for stores that have applied the earlier m9. If the earlier schema is explicitly unsupported development state instead, document that compatibility limit and an authorized migration/rebuild procedure; do not treat the fresh-store fix as an existing-store upgrade.

Probe: `opening_an_existing_m9_store_must_upgrade_the_plan_revision_key`.

## A6 [P1] F4 protection becomes stale while delivery is running

Location: [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs), lines 87–109 and 449–456.

The new preflight checks correctly reject a target already checked out at the beginning. They are not repeated after smoke or before publication. Another actor can check out an existing target branch while delivery is running without changing its commit ID, so the final expected-old-value assertion still succeeds.

The fixture starts on `main` with an existing target at the declared base. During smoke it simulates another actor checking out that target in the host. Delivery then returns `READY_FOR_MERGE`, and the caller's checkout reports `D  approved.txt`, reproducing the original F4 damage after the preflight condition became stale.

Required correction: recheck active-checkout and repository/ref prerequisites immediately before publication, under the applicable coordination policy. Preserve an explicit concurrency limitation where external checkout races cannot be made atomic; do not claim complete caller-checkout preservation from a single initial check.

Probe: `checked_out_target_must_be_rechecked_after_smoke`.

## Disposition

The original ignored-file, Git conversion, tracked smoke mutation, mismatched-base and initially-checked-out-target reproductions now reject correctly. Constraints/exclusions affect the initial plan fingerprint, and its earlier clock-dependent reproduction is repaired. These improvements are confirmed by the unchanged fourteen-probe rerun.

F4, F5, F6, F7 and F8 cannot yet be marked fully resolved for the reasons above. The original R1 engine/CLI integration remains explicitly deferred. The old diagnostic negative reproducer also still contains no assertions or pass/fail counter; its exit 0 is not a verified fourteen-test pass.
