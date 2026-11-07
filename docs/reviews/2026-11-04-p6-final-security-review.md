# P6-FINAL-SECURITY-REVIEW

**Project:** Deszo Agent Orchestrator
**Stage:** P6-FINAL-CLOSURE, Part II (P6-FINAL-SECURITY-REVIEW)
**Date:** 2026-11-04
**Verdict:** `P6-FINAL-SECURITY-REVIEW PASS`, with the bounded availability limitation D-2 accepted by the Owner for this acceptance scope (§14).

Every Critical, High and contract-breaking Medium finding raised in this stage is fixed, and the last focused review of the final change set found none new. The three gate items of the previous report are closed by executed evidence: B1 (S2-D), B2 (three real-Gate negatives), and D-2 (Owner decision, §14).

## 1. Gate items

| # | Item | Result | Evidence |
| --- | --- | --- | --- |
| B1 | S2-D: a second protected Repair admission against one consumed slot, in one installed release, is refused by the Judge-driven admission path with `p5_workspace_claimed`; no duplicate admission, claim, Run or P6 operation results | **PASS** (executed) | `docs/reviews/evidence/2026-11-04-p6-s2d-duplicate-claim.tap.log` (1 pass, 0 fail, exit 0); test `runtime/tests/p6-s2d-duplicate-claim.test.mjs` |
| B2 | Three real-Gate negatives under the existing P5 policy: invalid dependency closure, invalid running-source release, missing required causal verification | **PASS** (3/3 executed on the Gate) | `docs/reviews/evidence/2026-11-04-p6-gate-negatives.tap.log` (3 pass, 0 fail, exit 0); test `runtime/tests/p6-gate-negatives.test.mjs` |
| D-2 | Availability limitation of the synchronous alias walk and of unavailable enrolled slots | **Owner-accepted** for this bounded acceptance scope (§14) | Owner instruction; §14 |

## 2. Reviewed source

- Branch `codex/adr-0003-0005-completion`, HEAD `1f54c47fe265c6b47bf36695be56214056fc3af1`. The working tree is uncommitted; the Owner decides commits.
- The snapshot digest is computed at the Stage III freeze. This report describes the pre-freeze tree; Stage III reruns the affected evidence on the frozen bytes.
- Changes this round (all on the final tree): `runtime/core/engine.mjs` (agent-path refusal code, §8); `runtime/core/p5Gate.mjs` (test barrier, §9, fail-closed); `runtime/tests/{p5-protected-release,p6-s2d-duplicate-claim,p6-gate-negatives}.test.mjs` (new harness and tests).

## 3. Method and review rounds

Every review was run by a fresh-context reviewer with read-only access and no prior context. Reviewers were instructed to verify from source with file:line evidence and not to trust implementer narratives. Findings were checked against the code before any change.

| Round | Scope | Result |
| --- | --- | --- |
| R1 | S1 root-bound Parent; S2 workspace pool, aliases, refusals | S2-1 (High), S2-2 and S2-3 (Medium, contract-breaking); Low and accepted items |
| R2 | S3 Gate policy continuity; S4 P6 continuation and Git source | No Critical or High. S4-1 (Medium, trusted-closure omission); S3-1 (Medium, missing negative tests) |
| R3 | S5 genuine E2E integrity; H source hygiene | S5-1 (contract-breaking), S5-2 and S5-3 (Medium), S5-4 (High, stale packaged evidence) |
| R4–R7 | Remediation deltas (claim source, rebind guard, Parent and slot fixes) | Contract-breaking findings each fixed and re-reviewed; last round no Critical, High or contract-breaking Medium |
| R8 | Attempt-refusal code and the Gate test barrier (this round) | Five defects in the test evidence fixed (F2, F3, F5, F6, F7); F1 (Low) fixed; no Critical, High or contract-breaking Medium |

## 4. Root-profile binding (S1)

**Status: PASS.** Immutable Parent publications remain bound to the original root profile (`runtime/core/engine.mjs` around lines 436–449 and 494; `runtime/core/protectedSelfRepair.mjs` 165–167). The effective profile advances only through the Host-attested continuation (`resolveP6Continuation`, `runtime/core/p6Continuation.mjs`). A root enrollment file cannot carry `rootProfile` (`assertP5RootEnrollment`).

| Negative case | Refusal | Evidence (E = executed, C = code path only) |
| --- | --- | --- |
| changed root policy | `p5_profile_mismatch` | E: `runtime/tests/protected-self-repair.test.mjs` |
| forged successor profile | `p6_continuation_profile_mismatch` (`p6Continuation.mjs` 323) | E for the comparison helpers (`p6-successor-identity.test.mjs`, 8 tests); C for the resolver's throw |
| missing continuation | `p5_runtime_source_mismatch` / status reader required (`protectedSelfRepair.mjs` 215–217, 290–291) | C |
| wrong Host operation | `p6_continuation_host_status_mismatch` | E: `runtime/tests/p6-build-unit.test.mjs` |
| wrong installed package | `p6_continuation_host_status_mismatch` (`p6Continuation.mjs` 93–100) | C |
| changed Owner scope | `p6_continuation_profile_mismatch` | E for the scope field (`p6-successor-identity.test.mjs`) |
| changed budgets | `p6_continuation_profile_mismatch` | E for the budgets field (`p6-successor-identity.test.mjs`) |
| changed repository | `p5_repository_enrollment_mismatch` | E: `protected-self-repair.test.mjs` |
| changed publication policy | `p6_continuation_profile_mismatch` | E for the repair publication field (`p6-successor-identity.test.mjs`) |
| unrelated Parent publication | `p5_publication_mismatch` (`engine.mjs` 436–440) | C |

The Parent publication does not need republishing after A → B; that is by construction, since it pins the root profile. The C rows have no executed test; they are carried to Stage III's full regression as the code they name, and are not claimed as executed evidence here.

## 5. Workspace-pool isolation (S2)

**Status: PASS.** Properties and targeted cases below; the Owner decision D-2 is §14.

### 5.1 Properties

| # | Property | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Each enrolled slot is a real registered workspace | PASS | `assertSuccessorSlotRegistered` (`runtime/core/p6Consumer.mjs`); `p5-workspace-alias.test.mjs` |
| 2 | Entries are distinct | PASS | `assertP5WorkspacePool`; `p5-workspace-pool.test.mjs` |
| 3 | Entries are non-overlapping | PASS | `workspaceRootsOverlap` on real paths; `p5-workspace-pool.test.mjs` |
| 4 | No symlink or junction bypasses registration | PASS | `workspaceAliasOverlap` (`runtime/core/workspaceIsolation.mjs`); `p5-workspace-alias.test.mjs`, `p5-workspace-reserved-run.test.mjs` |
| 5 | No ancestor or descendant overlap | PASS | root overlap (`p5-workspace-pool.test.mjs`) |
| 6 | Alternate spellings | PASS for the cases probed (case, relative against absolute, trailing separator). 8.3 spelling of a missing path: residual R7 (§17) |
| 7 | Windows case-insensitive comparison | PASS (`p5-workspace-pool.test.mjs`) |
| 8 | Native identity authoritative | PASS with residuals R1, R2 (§17) |
| 9 | Consumed slot not claimed again | PASS: predicate on a real Store (`p5-workspace-reserved-run.test.mjs`); refusal executed end to end (B1, §8) |
| 10 | Ordinary Runs excluded from reserved slots | PASS (`p5-workspace-reserved-run.test.mjs`, S2-A and S2-E) |
| 11 | Parent Runs excluded | PASS through the reservation path; the genuine chain asserts `claimedSlotRefusal` (`p6-genuine-e2e.test.mjs`), rerun in Stage III |
| 12 | Generic P2 Repairs excluded from reserved slots | PASS (`p5-workspace-reserved-run.test.mjs`, S2-C) |
| 13 | Protected Repairs claim only their authorized slot | PASS (`protectedSelfRepairRepairWorkspaceId`) |
| 14 | Exhaustion fails closed | PASS in code (`p6_successor_workspace_exhausted` before any operation intent); the exhaustion E2E is rerun in Stage III |
| 15 | No implicit deletion or recycling | PASS for the P5/P6 slot paths |

### 5.2 Targeted regressions S2-A … S2-G

| Case | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| S2-A | ordinary Run refused, `p5_workspace_reserved` | PASS (executed) | `p5-workspace-reserved-run.test.mjs` |
| S2-B | Parent Run refused in a reserved slot | Asserted by the genuine chain; rerun in Stage III | `p6-genuine-e2e.test.mjs` `claimedSlotRefusal` |
| S2-C | generic P2 Repair refused, no claim or Run written | PASS (executed) | `p5-workspace-reserved-run.test.mjs` (`p5_workspace_enrolled`) |
| S2-D | duplicate protected claim refused, `p5_workspace_claimed` | **PASS (executed, B1)** | `p6-s2d-duplicate-claim.test.mjs`; evidence §16 |
| S2-E | alias and overlap, junctions and symbolic links | PASS (executed) | `p5-workspace-alias.test.mjs` (20 tests); `p5-workspace-reserved-run.test.mjs` (direct and chained junction) |
| S2-F | exhaustion refuses before intent, build, staging, switch | PASS in code; exhaustion E2E rerun in Stage III | `p6-genuine-e2e.test.mjs` exhaustion variant |
| S2-G | valid three-slot chain | Pending the genuine A→B→C rerun in Stage III | `p6-genuine-e2e.test.mjs` |

## 6. Alias and overlap verification

`workspaceAliasOverlap` (`runtime/core/workspaceIsolation.mjs`) follows every junction and symbolic link from a workspace, including chains through directories outside it; each real directory is visited once. It reports an overlap for any reached directory or alias target overlapping a protected root, for an unreadable directory, for a dangling alias whose declared target overlaps, and for a walk past `ALIAS_WALK_ENTRY_LIMIT` (250,000 entries). Every failure path returns "reserved". Probes on Windows junctions: a junction into a slot, a container of a slot, and a chain through an unrelated directory were refused; an unrelated junction was admitted; a cycle terminated.

**Residuals (§17):** R1 (an alias created during an admitted Run), R2 (hard links), R3 (Developer confinement not verified), R7 (8.3 spelling of a missing claimed path restored mid-Run). The walk is synchronous; its cost is D-2 (§14).

## 7. Ordinary and generic refusals

- Ordinary Run into an enrolled or claimed slot, or a workspace reaching one: `p5_workspace_reserved` (409), before any Run row is written (`p5-workspace-reserved-run.test.mjs`).
- Generic linked Repair into an enrolled slot: `p5_workspace_enrolled` (409), before any link or Run (`p5-workspace-reserved-run.test.mjs`).
- A generic P2 claim does not reserve an ordinary workspace (real Store, `p5-workspace-reserved-run.test.mjs`).

## 8. Duplicate slot claim (S2-D, B1)

**Result: PASS, executed.** `runtime/tests/p6-s2d-duplicate-claim.test.mjs` drives the production Judge-driven Repair admission twice against one installed release:

1. The first Parent incident is admitted by its Judge; the Repair opens a link and claims the enrolled slot (`p5-slot-1`). Its Developer fails at once (no plan is written), so the Repair never produces a candidate, a handoff or a P6 switch. The claim is permanent (P5-08).
2. A second Parent incident reaches the same admission path. Its Judge attempt is refused in the commit transaction by `p5_workspace_claimed`.

The test asserts, after the second admission: exactly one claim on the slot; exactly one Run in the slot; no link for the second Parent; no handoff; no `engine_switch_accepted` or `engine_staged` Host event; no P6 operation; and no applied Judge decision with a repair effect (decision artifacts read from the Store). It asserts the refusal code on the Judge attempt's failure outcome (`rawCode === 'p5_workspace_claimed'`) and the admission's sentence on the journaled attempt error.

**Production defect found and fixed.** The refusal code was discarded: the agent runner's generic catch recorded every non-corruption error as the canonical `process`, so the journal named a generic process failure for a P5 admission refusal. Fix (`runtime/core/engine.mjs`, the attempt runner's catch): a P5 refusal (code starting `p5_`) is passed to `failAttempt` as `{ rawCode }`. The canonical code, the attempt vocabulary and the cause knowledge are unchanged (`deterministic_interpretation`). Reviewed in R8: no consumer reads the raw code to decide retry, recovery or category.

## 9. Gate and root-policy continuity (S3, B2)

**Result: PASS, executed on the real Gate.** Each negative provisions its own installed release (a Repair claims the enrolled slot, so each needs a fresh one), runs the Repair to its trusted Gate, and reads the refusal from the verify node's durable failure outcome or verification record. No handoff results in any case.

| Negative | Refusal | Source of the refusal |
| --- | --- | --- |
| 1. Invalid dependency closure: the candidate's protected subject imports a package the attested release does not contain | `p5_subject_external_dependency_unsupported` | Gate preparation, subject resolution (`runtime/core/p5Gate.mjs`, the uninstalled-dependency check) |
| 2. Invalid running-source release: the trusted verifier the Gate runs is altered (same size) after the candidate is captured | `source_release_unavailable`, Host sentence "build artifact digest is invalid: …p5Verifier.mjs", journaled on the verify attempt | The Gate's own running-release attestation, the first installed-release read after the alteration (`p5Gate.mjs`, the attestation at the start of `prepareProtectedSelfRepairGate`; Host `verify_build_artifact_set`) |
| 3. Missing required causal verification: the candidate does not demonstrate the causal repair (`incident-repaired` fails on it) | `p5_verification_failed`; verification status `failed`; no causal record | The Gate's verification: a failed required check; no causal record is issued unless the verification passes (`p5Gate.mjs`) |

**Determinism of negative 2.** The alteration happens inside a test barrier (`testGateBarrier`, `runtime/core/p5Gate.mjs`), placed at the start of the Gate's preparation, before its first installed-release read. The barrier is active only when the test names a barrier directory and `testFaultHooksEnabled` is true; that policy is false in every packaged production release (`runtime/core/testFaultPolicy.mjs`: the test marker in a manifest directory, or an unbundled source run). The barrier fails closed: a missing release after 120 seconds refuses with `p5_test_barrier_timeout`.

**Layering, stated plainly.** The Host verifies the installed release at every Engine-issued launch, at the P5 candidate capture, and at the Gate. A same-size alteration made earlier is therefore refused at the first later consultation: the Developer's launch or the candidate capture. Negative 2 is the case where the alteration precedes only the Gate's consultation, which the barrier makes deterministic. Negative 1 is exercised through an uninstalled import, not through tampered installed bytes, because the Host's integrity check refuses tampered installed bytes before the Gate's dependency check runs.

## 10. Host-bound P5 continuation (S4)

**Status: PASS, with the trusted-closure omission fixed (S4-1).**

- The B continuation is bound to the A → B Host commit, and C to B → C. The committed operation id, package digest, source commit and inputs digest are compared with the Host-attested release.
- No candidate-generated success flag substitutes for Host authority; receipts are written only through `command_receipts`.
- The successor selects exactly the next pool slot (`nextP5WorkspaceSlot`); a missing, wrong or unrecorded slot refuses.
- Root Owner policy cannot widen: scope, budgets, repository identity, publication, node identities, retry and acceptance mode are compared with the root (`successorProfileFieldsMatch`).
- Local Git availability is not remote publication; `fetchRefs` is unchanged; no automatic push on this path. The only `push` is `p5GitCandidate.mjs`, reached from an Owner route or the startup replay of an Owner-requested intent (S4-6).

Low items recorded: S4-2 (replay does not recheck the slot before reuse), S4-3 (successor dependency set from the first installed version with `p5/node_modules`), S4-5 (a dead `receipt` field in `lifecycle-host/src/engine_switch.rs`), S4-7 (`testFaultHooks` true for unpackaged code).

## 11. Source provenance

- `runtime/core/p6GitObjectSource.mjs` was missing from `P5_TRUSTED_CONTROL_PATHS` (S4-1). Added, with a test that fails if any installed P6 core module is omitted (`p5-workspace-alias.test.mjs`).
- `runtime/core/testFaultPolicy.mjs` was missing from the list (D-8). Added. The file is untracked, and the Owner commits it with its importers (`custody.mjs`, `lock.mjs`, `runner.mjs`, `host/lifecycleBridge.mjs`, `host/runtimeBinding.mjs`, `core/p6Consumer.mjs`, `core/p5Gate.mjs`).
- The trusted closure changes with every byte edit to a listed file (`runtime/core/p5Gate.mjs`, `runtime/core/engine.mjs` in this round). Releases and enrollments built before those edits refuse until rebuilt and re-enrolled. Stage III rebuilds from the final bytes.
- Store-backed Git source preserves the exact commit and tree identity (`p6Reconstruction.mjs` around 182–198).
- The Rust Host copies `inputs_digest` and `dirty_source_digest` from `build.json` and does not recompute `authorityClosureDigest`, `dependencyDigest` or `builderIdentity` (S3-4, accepted; binding rests on the package digest and the trusted packager).

## 12. Receipt evidence

Not yet extracted. The brief's additional-evidence list (both P6BuildReceipt artifact IDs and digests, both package digests, both reproducibility digests, both Host operation identities, B and C continuation artifact IDs, C's successor profile and slot) comes from a genuine A→B→C run on the frozen tree, so it is extracted in Stage III. The earlier evidence (`docs/reviews/evidence/2026-11-04-p6-genuine-e2e-evidence.json`) predates the final tree and is not accepted for it.

## 13. Genuine E2E integrity and Owner-action trace (S5)

**Status: fixed in the test; the packaged rerun is Stage III.**

- Both accepted handoffs originate from production P5 acceptance (`linkedRepair.mjs`, the `self_repair.handoff_recorded` producer). The test does not create handoffs or call the manual activation route. Controlled responses (Developer, Judge, Parent worker) are identified in the test header and the report.
- S5-1 (contract-breaking): every Owner HTTP call goes through a traced wrapper around `api()`, the only HTTP client in the chain. Between B's verified switch and C's verified switch, only GET and `POST /api/v2/runs` (Parent incident starts) are allowed; root enrollment bytes and the origin's `for-each-ref` output must be unchanged across the window (`closeWindow`).
- S5-2 (Medium): the handoff is read from the Store and checked: a passed verification receipt, the P2 approval and authorization, the Judge attempt, Host provenance and the managed-clone candidate.
- S5-3 (Medium): operation B is bound to handoff A (`engine-<candidateId[0:12]>`); operation C switches from B and is bound to handoff B; the two Repairs produce distinct candidates and managed clones.
- S5-4 (High, evidence): the packaged evidence predates the final bytes. Stage III reruns the packaged genuine A→B→C and the exhaustion E2E on the frozen tree.
- S5-5 (Low): the fresh managed clone is partly covered by the distinct-clone assertion; clone creation itself is not traced.
- S5-6 (accepted): the production absence of the P6 route is evidenced only by a 2026-11-02 run (404 on an unmarked package). Stated as "not called", not "absent".
- S5-7 (accepted): the Judge proves that it ran, not the semantic judgement; this is a controlled provider response.

## 14. Findings, remediation and the Owner decision

| ID | Severity | Contract-breaking | Status | Fix and test |
| --- | --- | --- | --- | --- |
| S2-1 | High | yes | Fixed | Alias walk (`workspaceAliasOverlap`); `p5-workspace-alias.test.mjs`, `p5-workspace-reserved-run.test.mjs` |
| S2-2 | Medium | yes | Fixed | Successor registration check before any P6 state (`assertSuccessorSlotRegistered`); test |
| S2-3 | Medium | yes | Fixed | Unbound runtime reads the profile enrollment; test |
| S2-4 | Low | no | Mitigated by the rebind guard (F-1) | `protectedSelfRepairRootLocked`; real-Store and malformed-file PUT tests |
| S2-5 | Low | no | Recorded | Defence in depth: bind P5 admission to the enrolled workspace in `captureRun` |
| S2-6 | Low | no | Recorded | Relative roots are refused by the Host (`custody.rs`); schema absolute pattern pending |
| S2-7 | Low | no | Recorded | Install identities optional; no production installer exists yet |
| S3-1 | Medium | no | **Fixed** | Gate negatives B2 (§9) and the helper tests (`p6-successor-identity.test.mjs`) |
| S3-2 | Low | no | Recorded | Parent-pinned profile equality replaced by capture and admission checks |
| S3-3 | Low | no | Recorded | Causal reproduction optional in the schema; enforced at admission |
| S3-4 | Accepted | no | Recorded | Harness closure written by the builder; binding via the package digest and trusted packager |
| S4-1 | Medium | yes | Fixed | `p6GitObjectSource.mjs` added to the trusted list; test |
| S4-2..S4-7 | Low / accepted | no | Recorded | §10 |
| S5-1 | High | yes | Fixed (test) | Owner-action window trace; packaged rerun in Stage III |
| S5-2 | Medium | no | Fixed (test) | Handoff content checks; packaged rerun in Stage III |
| S5-3 | Medium | no | Fixed (test) | Operations bound to their handoffs; packaged rerun in Stage III |
| S5-4 | High | no | Stage III | Packaged evidence rerun on the final tree |
| S5-5 | Low | no | Partly fixed | Distinct candidate and clone; clone creation not traced |
| H-1 | Low | no | Accepted | Debug seams are refused by release configuration validation and compiled in; maintainer follow-up |
| H-2 | Low | no | Accepted | `dev_test_confirmation_off` not refused at the Host config; fail-closed at the Engine |
| D-1 (R4, R5) | Medium | yes | Fixed | Store-root fallback; installed-file fallback applies the loader's pool rule; tests |
| D-2 (R5) | Medium | no | Fixed | Claimed slot with a removed directory compares its declared path; test |
| D-3 (R5) | Low | no | Fixed | Unreadable authorization claims its slot; test |
| D-4 (R5) | Medium | no | Mitigated | Authorization decisions cached per artifact id; the link scan still runs per Run creation (about 25 ms at 5,000 links, reviewer measurement) |
| D-5 (R5) | Low | no | Fixed | Real-Store claim test |
| D-6 (R5) | Low | no | Commit note | `testFaultPolicy.mjs` is committed with its importers |
| F-1 (R6) | Medium | yes | Fixed | `protectedSelfRepairRootLocked`; a rebind of an enrolled or claimed slot refuses with 409 `p5_workspace_enrolled`; tests |
| F-2 (R6) | Medium | no | Partly fixed | Declared-path fallback only for ENOENT; 8.3 spelling of a missing path is R7 |
| F-3 (R6) | Low | no | Fixed | Dangling-junction and parent-junction tests |
| F-A (R7) | Low | no | Accepted | Create branch has no root guard for an enrolled id with no row; reachable only from an inconsistent store, where P5 admission refuses |
| F-B (R7) | Accepted | no | Accepted | Filesystem retarget or rename of a claimed root after admission (R1 class) |
| F-C (R7) | Low | no | Fixed | Regular-file claimed root and malformed-file rebind tests |
| F-D (R7) | Low | no | Accepted | Claimed root under a regular file takes the declared path; no content can exist under a file |
| F-E (R7) | Low | no | Stage III | Bundles under `dist-runtime/` and `src-tauri/target/` predate the guards; rebuilt in Stage III |
| R8b-F1 | Low | no | **Fixed** | Gate test barrier fails closed after its deadline (`p5_test_barrier_timeout`) |
| R8-F2 | Medium | no | **Fixed** | S2-D no-repair-effect check reads the decision artifacts (the journal holds only references) |
| R8-F3 | Medium | no | **Fixed** | S2-D re-asserts handoffs and Host switch events after the second admission |
| R8-F4 | Medium | no | **Fixed** | Gate negative 2 is deterministic: the test barrier (§9) |
| R8-F5 | Medium | no | **Fixed** | Gate negative 3 asserts the failed verification and the failing required check, not any refusal |
| R8-F6 | Medium | no | **Fixed** | Harness stops any running Host before releasing the slots, whether or not assertions passed |
| R8-F7 | Low | no | **Fixed** | Provisioning closes its Store handle on failure |
| R8a-F1 | Low | no | **Fixed** | Refusal code passed as `rawCode` only; canonical code and cause knowledge unchanged |

**Owner decision D-2 — accepted for this bounded acceptance scope.** The Owner decided: retain the existing fail-closed behaviour, including the 250,000-entry limit; do not raise the limit or introduce asynchronous admission in this closure stage. The following are accepted limitations of this scope, and nothing in this report claims otherwise:

- Workspaces exceeding the limit are unsupported under the current admission implementation.
- An unavailable enrolled P5 slot can prevent ordinary Run admission.
- The synchronous alias walk has measurable performance and availability costs (about 150 ms for 20,200 entries; about 10.9 s for the 597,202-entry Deszo repository tree, which is refused at the cap).
- These are accepted limitations for this bounded acceptance scope. They are not evidence that arbitrary large workspaces are production-ready.

**Follow-up (not started in this stage):** asynchronous, fail-closed workspace admission and more selective handling of unavailable enrolled roots. That implementation must not admit a Run before the required isolation checks pass.

## 15. Final independent review

- R4–R8 are fresh-context, read-only reviews of each delta (§3). R8 reviewed the attempt-refusal change and the Gate test barrier: no Critical, High or contract-breaking Medium. Its Low and evidence findings (F1–F7 of that review) are fixed in this report's §14.
- R8 also noted that the Stage II evidence logs must be tied to the final source bytes. Stage III records the source closure digest on the frozen tree and reruns the affected suites on it.

## 16. Focused test evidence (Stage II)

- `docs/reviews/evidence/2026-11-04-p6-security-stage2-focused-final.tap.log`: 124 pass, 0 fail, 0 cancelled, 0 skipped; exit 0. Covers `protected-self-repair`, `p6-build-unit`, `p5-desktop-layout`, `p5-managed-clone`, `linked-repair-isolation`, `p5-workspace-alias`, `p5-workspace-reserved-run`, `p5-workspace-pool`, `p6-successor-identity`, `workflow-judge-policy`, `workflow-continuation`, `workflow-continuation-strict`, `parent-repair-coordination`.
- `docs/reviews/evidence/2026-11-04-p6-s2d-duplicate-claim.tap.log`: 1 pass, 0 fail (B1).
- `docs/reviews/evidence/2026-11-04-p6-gate-negatives.tap.log`: 3 pass, 0 fail, exit 0 (B2), on the final bytes of `runtime/core/p5Gate.mjs` (after the barrier's fail-closed change).
- Earlier logs (`2026-11-04-p6-security-focused-final.tap.log`, `…round2`, `…round3`, `…real-store-claim`, `…reservation-round3b`) are kept as history; the Stage II results above are the ones that apply to the final tree.
- Stage I (M1): `docs/reviews/2026-11-04-p6-host-m1-close.md`.

No genuine E2E and no full Node or Rust regression have been run in this stage. Those are Stage III.

## 17. Accepted limitations and residuals

| ID | Limitation | Owner |
| --- | --- | --- |
| R1 | Alias created during an admitted Run is not seen | Host maintainer (process confinement) |
| R2 | Hard links are not seen by any path-level check | Host maintainer (process confinement) |
| R3 | Developer confinement by Lifecycle Host custody was not verified | Host maintainer |
| R7 | 8.3 spelling of a missing claimed path restored mid-Run | Owner (Owner action during a Run) |
| S3-4 | Harness closure written by the builder; binding via digest and trusted packager | Release process |
| S4-6 | Startup replay of an Owner-requested publication intent | Owner |
| D-2 | Availability: enrolled slot removal and the 250,000-entry walk cap (§14) | Owner, accepted for this scope |
| H-1, H-2 | Debug seams and dev-test confirmation are compiled in; refused by release configuration | Host maintainer |
| F-A, F-D | Low classification differences with no retained-content exposure | Host maintainer |
| F-B | Filesystem retarget or rename of a claimed root after admission | Host maintainer; native-identity check is the proposed follow-up |

## 18. Gate decision

`P6-FINAL-SECURITY-REVIEW PASS`.

- B1 (S2-D) and B2 (three real-Gate negatives) are executed and passing.
- D-2 is an Owner-accepted availability limitation for this bounded acceptance scope, with the qualifications in §14.
- No unresolved Critical, High or contract-breaking Medium finding remains in the final review.

Stage III starts on a frozen source snapshot: rebuild `dist-runtime/`, the Host and the Tauri artifacts from the final source; include `runtime/core/testFaultPolicy.mjs` and its importers; rerun the packaged genuine A→B→C and the workspace-exhaustion E2E; then run the complete Node and Rust regression on that one frozen snapshot. Nothing has been committed or pushed.
