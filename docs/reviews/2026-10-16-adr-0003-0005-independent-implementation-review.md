# Independent implementation review: ADR-0003 through ADR-0005

Date: 2026-10-16
Verdict: **Changes required. The claimed Stage 1–3 completion is not established.**

## Scope and evidence

Reviewed the local schemas, migration 9, three new runtime modules, their unit tests, registration/bundling changes and implementation-status documents. The three new runtime modules were checked against a captured copy and remain identical after line-ending normalization.

The workspace changed during the first test run: HEAD moved from 9d25d91 to a49833c and a stash application left seven conflicts. At the user's request those conflicts were resolved, main was fast-forwarded to the already fetched origin/main at 7178032, and local changes were restored. Both the original stash and an additional recovery stash were retained. That interrupted first test run is not evidence of an implementation regression.

Fourteen negative probes were run using pure functions and temporary fixture Git repositories. Their [recorded results](evidence/2026-10-16-adr-0003-0005-negative-probes.json) demonstrate behavior missing from the happy-path tests. The [reproduction script](evidence/2026-10-16-adr-0003-0005-negative-probes.mjs) can be run from the project root with:

~~~powershell
node --disable-warning=ExperimentalWarning docs/reviews/evidence/2026-10-16-adr-0003-0005-negative-probes.mjs
~~~

The script creates fixture repositories in a fresh temporary root. It exercises no delivery against the user's repository. Its optional first argument selects a JSON output file.

## Findings

### R1 [P1] New mechanisms are not connected to ordinary execution

Location: [taskAssessment.mjs:68](../../runtime/core/taskAssessment.mjs), [contextPackage.mjs](../../runtime/core/contextPackage.mjs), [branchDelivery.mjs](../../runtime/core/branchDelivery.mjs).

Repository-wide call-site inspection finds imports/calls only in the new unit tests. Engine, Map execution, Gate evaluation, runtime routes and the MCP bridge do not invoke these modules. The migration creates the new tables, but no production handler persists the corresponding records. Plan selection returns stage names rather than a compiled executable workflow.

Consequently candidate-time escalation is not mandatory at assembly, aggregate limits do not govern live dispatch, acceptance records do not constrain the existing Gate, package-aware fingerprints do not change actual carry, and request/resume does not resume a real CLI invocation. Schema registration and a successful bundle do not establish these behaviors.

Required change: wire the mechanisms into managed lifecycle/API execution and storage, then verify real fixture runs through those interfaces. Until that exists, describe these files as unintegrated foundations rather than Stage 1–3 completion.

### R2 [P1] Delivery recursively deletes any supplied existing clone directory

Location: [branchDelivery.mjs:57](../../runtime/core/branchDelivery.mjs).

Before establishing ownership or containment, executeBranchDelivery removes cloneDir recursively. There is no check that it is a runtime-owned directory or even distinct from repositoryPath. An existing directory containing a sentinel file was deleted and replaced with a clone; delivery reported READY_FOR_MERGE.

Probe: existing_clone_directory_is_deleted.

Required change: allocate/register an owned destination, verify resolved paths and ownership, reject collisions, and never remove an arbitrary caller-supplied directory.

### R3 [P1] Candidate paths can write outside the clone

Location: [branchDelivery.mjs:80](../../runtime/core/branchDelivery.mjs).

Candidate paths are joined to cloneDir and written without normalization, containment, metadata or symlink checks. A candidate entry ../outside.txt overwrote a file outside the clone while the result still reported READY_FOR_MERGE. Git metadata is not excluded either.

Probe: candidate_path_escapes_clone.

Required change: validate canonical relative paths and file operations before any writes; reject traversal, metadata paths, collisions and symlink escapes, and verify destination ownership.

### R4 [P1] Readiness does not establish that the committed content is the accepted candidate

Location: [branchDelivery.mjs:138](../../runtime/core/branchDelivery.mjs) and [branchDelivery.mjs:164](../../runtime/core/branchDelivery.mjs).

The manifest is computed from supplied candidateFiles, not the actual checkout. It is never compared with plan.candidateDigest. After smoke, git add -A stages all changes without revalidating content. The tree recorded before commit is not compared with the actual committed tree afterward.

A smoke command changed approved.txt and added an undeclared file. Both were committed with READY_FOR_MERGE while the reported manifest still matched the original requested candidate. A second probe installed a pre-commit hook during smoke: the returned treeId differed from the actual committed tree, again with readiness.

Probes: smoke_mutation_commits_unreviewed_source; hook_mutation_is_not_compared_to_recorded_tree.

Required change: resolve the approved immutable candidate and evidence, verify the complete allowed manifest before staging and after checks, validate staged/committed content and transformations, and reject any unexpected change before ref publication.

### R5 [P1] Expected-old-value checks permit replacing an existing branch with unrelated history

Location: [branchDelivery.mjs:165](../../runtime/core/branchDelivery.mjs).

Delivery checks the branch's current value, but commits on plan.baseCommit without verifying the required parent/ancestry relationship. A plan using old base A and a current expected feature head B successfully changed the branch to C whose parent was A. B was not an ancestor of C and B's existing feature file disappeared from the branch.

Probe: existing_branch_can_be_rewound_to_older_base.

Required change: validate the expected parent and allowed fast-forward relationship before publishing an existing ref. A matching expected-old-value is race protection, not permission to discard history.

### R6 [P1] Hook policy records execution without installing or enforcing hooks

Location: [branchDelivery.mjs:72](../../runtime/core/branchDelivery.mjs).

The hook branch only changes a string when hookSource exists. It does not install the hook or configure a controlled hooks path, but the result reports executed. A required pre-commit hook that exits 7 was absent from the clone and did not block readiness. Conversely a hook created during smoke ran under a policy reporting none.

Probes: configured_hook_is_not_installed_or_executed; hook_mutation_is_not_compared_to_recorded_tree.

Required change: implement and verify the effective per-clone hook policy, capture actual execution/evidence and reject unsupported or unavailable required hooks. Do not derive execution facts from a policy flag.

### R7 [P1] Git and smoke processes bypass managed execution and have no timeout

Location: [branchDelivery.mjs:98](../../runtime/core/branchDelivery.mjs).

Git and smoke use spawnSync without a timeout, run-owned process registration, stream capture or aggregate-budget charging. A long-running smoke blocks the caller's Node event loop; if connected directly to the runtime, ordinary observation/Stop processing cannot continue through that loop. There is no run-owned process path to provide the ADR-0002 containment proof.

This is source inspection; an indefinite hang was not launched.

Required change: use the existing managed asynchronous process/supervisor path, charge bounds before dispatch and on completion, and capture commands/streams/outcomes durably.

### R8 [P1] Acceptance can open with zero criteria or zero evidence

Location: [contextPackage.mjs:265](../../runtime/core/contextPackage.mjs), [acceptance schema](../schemas/acceptance-record.schema.json).

An accepted record with criteria: [] returns canOpenGate: true. A satisfied criterion with evidenceRefs: [] does the same. The validator receives no expected criterion inventory or store/source context, so omitted criteria, nonexistent evidence and wrong-subject evidence cannot be checked.

Probes: empty_acceptance_opens_gate; satisfied_without_evidence_opens_gate.

Required change: evaluate against the required criterion inventory for the selected boundary, require appropriate evidence for satisfaction, resolve trusted records and validate their candidate/configuration/freshness before opening a Gate. Preserve semantic review separately.

### R9 [P1] Missing explicit bindings are replaced with invented models and efforts

Location: [taskAssessment.mjs:150](../../runtime/core/taskAssessment.mjs).

Omitting roleBindings silently inserts analyst-v1, dev-v1, test-v1 and review-v1 with hardcoded providers/efforts. These are not the user's selected bindings and the plan still passes its schema. This contradicts explicit model/effort selection and makes missing configuration look like a usable plan.

Probe: missing_bindings_get_invented_model_defaults.

Required change: require and validate bindings/capabilities for invoked roles. Missing configuration must produce a planning diagnostic without provider/model/effort substitution.

### R10 [P2] Reviewer separation checks JavaScript object identity

Location: [taskAssessment.mjs:159](../../runtime/core/taskAssessment.mjs).

The guard rejects a duplicate role only when both bindings are the same in-memory object. Two separately allocated objects with identical role IDs pass. Serialized JSON bindings naturally arrive as separate objects, so the test using a shared object reference misses the actual input case.

Probe: equivalent_but_distinct_reviewer_objects_bypass_separation.

Required change: validate distinct role/assignment identities and Context separation using serialized values. Identical model/provider choices remain permitted for the two distinct reviewer roles.

### R11 [P2] Plan fingerprints omit requirements and aggregate limits

Location: [taskAssessment.mjs:166](../../runtime/core/taskAssessment.mjs).

The fingerprint covers classification/stages/source hash/bindings/boundary but not assessment content, requirements, complete policy/check inputs or aggregate limits. Changing the intended task and criterion set, and raising maxAttempts from 5 to 100, produced the same fingerprint.

Probe: plan_fingerprint_ignores_requirement_and_budget_changes.

Required change: define a canonical semantic planning-input closure and hash all behavior-affecting captured inputs while excluding only record metadata/layout. Use that identity consistently for revisions and compatibility.

### R12 [P2] Expanded package fingerprints include attempt metadata

Location: [contextPackage.mjs:208](../../runtime/core/contextPackage.mjs).

Initial package construction hashes semantic fields. Expansion instead hashes the entire package wrapper, including packageId, createdAt and contextBinding.stepInstanceId. Packages with identical original semantic hashes become different after retrieving identical content solely because their attempt identities differ.

Probe: package_expansion_hash_depends_on_attempt_identity.

Required change: reuse one canonical semantic fingerprint builder for construction and expansion, normalize ordering/deduplication and keep package/attempt record identity separate.

### R13 [P2] Partial context retrieval drops unresolved dependencies

Location: [contextPackage.mjs:183](../../runtime/core/contextPackage.mjs).

Retrieval fails only when every requested path is missing. Requesting one available dependency and one missing dependency returns resumed: true without reporting the missing item or retaining an outstanding request. The blocking information gap is lost.

Probe: partially_missing_context_request_is_treated_as_resumable.

Required change: preserve unresolved request items and their reasons. Partial materialization may support another turn, but a blocking missing dependency must remain explicit and must prevent a completed approval.

### R14 [P2] Uncertainty and verifiability do not affect planning

Location: [taskAssessment.mjs:101](../../runtime/core/taskAssessment.mjs).

Selection uses impact, coupling and difficulty, but ignores uncertainty, verifiability and unresolved questions. A high-uncertainty task with unverified acceptance and an unresolved semantic question still selects the compact stages. There is no independent Business Accepter selection/configuration path or bounded discovery stage.

Probe: high_uncertainty_unverified_task_still_gets_compact_plan.

Required change: implement the recorded policy rules for discovery/reassessment, unresolved limitations and optional required independent acceptance. A caller's unvalidated confirmation Boolean is not an independent review certificate.

## Verification

- After conflict resolution: no unmerged index entries or conflict markers; schema/store syntax checks pass.
- docs:check passes with 27 schemas and 76 Markdown files including this review.
- Application build and runtime bundle pass on the restored working copy.
- All 17 new module tests pass; the fourteen additional negative probes reproduce the behaviors above.
- The first live full-suite run was invalidated by the concurrent checkout/conflicts.
- A full suite in the user-profile temporary snapshot had configuration/ancestor-isolation failures; it is not attributed to these changes.
- Stable post-resolution execution passed all 422 tests belonging to the package script's top-level `runtime/tests/*.test.mjs` scope. HEAD stayed at 7178032 and the execution receipt reported no source changes during the run.
- The independent review driver's recursive enumeration also selected two fixture-only `runtime/tests/toy/*.test.mjs` files, which are outside that package-script scope and fail without their fixture API. Thus the overbroad command's raw result was 424 tests, 422 passed, 2 failed, exit code 1. This is a review-driver selection error, not two attributed implementation regressions. The selector was corrected for subsequent use; no claim is made that the overbroad command exited successfully.

No runtime implementation fixes were made as part of this review. The authorized Git conflict resolution and the review artifacts are separate from a change to the new modules.

