# P6 Minimal Architecture — Simplification and Independent Review

Date: 2026-10-30. Current proposal: [ADR-0010](../adr/0010-p6-trusted-build-activation-rollback.md). Related evidence: [existing capabilities](2026-10-30-p6-existing-capabilities.md), [contracts](2026-10-30-p6-contracts.md), [recovery matrix](2026-10-30-p6-recovery-matrix.md), and [implementation plan](2026-10-30-p6-implementation-plan.md).

**ADR status remains Proposed. Architecture verdict: `P6 MINIMAL ARCHITECTURE READY WITH LIMITATIONS`.** This is design readiness only. H1 cannot run P6; the Host patch, Engine consumer, P5 continuation, and Windows acceptance evidence do not exist yet.

## 1. Owner decision

An accepted, currently eligible P5 Self-Repair handoff triggers P6 automatically. The currently installed Engine validates the handoff, reconstructs its exact source, invokes the fixed trusted builder, verifies the result, and requests activation. No further Owner or Judge decision, per-release approval, permission prompt, or automatic grant is part of P6.

The current Engine remains the authority for P5 eligibility and source/build preparation. The Lifecycle Host remains the authority for the exact staged package, native process tree, Engine selection, and the one safe precommit recovery. The Host does not interpret P5 or become a build service. Self-Repair never updates the Host or shell.

## 2. Previous and revised architecture

| Area | Earlier Proposed P6 | Revised minimal P6 |
|---|---|---|
| Trigger and authority | Separate Owner approval for build and activation, with selected authorization heads | Eligible accepted P5 handoff automatically starts one bounded P6 operation; existing P5 and installation trust remain in force |
| Source and build | Host-side P5/P6 admission and extensive release authorization | Installed Engine A revalidates P5 and uses a fixed installed builder on exact accepted source; Host verifies the resulting package bytes and identity |
| Host | Comprehensive H2 admission, authorization, probation, and recovery framework | Reuse Rust Host lifecycle, authenticated IPC, install lock, active selection, journal, and Process Custody; add only the compatibility behavior in §5 |
| Activation | Extensive role, probation, and rollback contracts | Stage while A is selected; run B's read-only maintenance preflight; atomically commit one fixed B target only after A is stopped and Store/process facts are held |
| Failure recovery | General probation and rollback | B preflight runs after A stops against a guarded disposable Store copy. Before B commit, one exact A fallback is allowed only with process certainty and unchanged production Store facts. Postcommit startup failure leaves B selected |
| Durable state | Multiple grants, selected heads, and extensive operation state | Existing P5 objects, one immutable P6 intent and receipt chain, one Host `active.json` committed selector, and profile `lifecycle.json` pending operation state |
| P5 after update | Manual re-enrollment after B | Immutable enrollment root plus Host-receipt-backed P6 continuation; no recurring Owner action |

The new design explicitly moves P5 admission and source-verification trust to Engine A. Host independently validates the exact package and process identities it selects, but does not independently replay the P5 graph, reproduce the build, or decide whether the repair is appropriate.

## 3. Removed components and contracts

The revised proposal removes:

- Per-release Owner build grants and activation grants.
- Grant/revoke chains, selected authorization heads, and approval-specific rebind machinery.
- Approval UI, administrative approval endpoints, and associated workflows.
- Host-side P5 journal/Judge interpretation and a duplicate P5/P6 admission adapter.
- A general updater service, second scheduler, second release Store, or generic authorization/policy framework.
- Multiple simultaneous candidate updates, generalized migration coordination, and database snapshot restoration.
- Extensive probation, broad monitoring, automatic Host updates, and activation of embedded UI changes.

The P6 operation is not an implicit grant. It is a single operation bound to the exact P5 handoff, installed A baseline, build receipt, package, and Host operation. Its immutable progress responses use the existing `command_receipts`; it has no P6 phase table or mutable authorization head.

## 4. Remaining Host responsibilities

The Host must know the shell and selected Engine identities, verify exact staged bytes, serialize one update under its installation lock, fence Custody starts, prove all managed Jobs are empty, stop A, launch/retain the exact B process, and persist one atomic selector and operation across restart. It must commit B only after B's dedicated read-only preflight succeeds and A has ended. Before that commit, it may restore exact A only when all relevant process and Store facts remain certain. Uncertain state is held.

Host reuses the existing Rust process ownership, installation lock, authenticated channel, package hashing, atomic file replacement, active-selection state, operation journal, Process Custody, and readiness transport. It never classifies or kills workflow/provider Jobs and never evaluates incidents, Judge decisions, P5 journals, or source changes.

## 5. Required Host compatibility patch

The separately authorized maintainer Host/shell release must implement the following narrow compatibility contract:

| Patch | Required behavior | Why required |
|---|---|---|
| H-min-1 — Identity split | Keep compiled `shellBuildId`/`shellRoot` stable while selecting a separate `engineBuildId`/`engineRoot`; update `build.json`, Host launch, Tauri bootstrap, and readiness binding. | H1 requires `desktopBuildId == buildId` and the executable under the selected application root, so it cannot load B under unchanged shell A. |
| H-min-2 — Exact stage | Verify and stage one complete Engine package from the authenticated current Engine before stopping A. Bind shell, Engine, manifest, source, package, and frozen-resource identities. | Prevent incomplete, changed, or substituted bytes from reaching launch. |
| H-min-3 — Durable switch | Use the authoritative `.deszo-host/active.json` committed selector, profile `lifecycle.json` for pending operation and recovery state, and Host lock for one staged operation, fixed A/B identities, atomic B commit, and restart reconciliation. Staging does not select B. | Prevent a Host restart or directory scan from choosing an unrecorded version. |
| H-min-4 — Custody fence | Require A to settle its work to zero active Custody Jobs; fence new Host Custody starts and prove zero again before stopping A. | Avoid concurrent Engine/provider execution and close the start/stop race. |
| H-min-5 — Preflight and bounded fallback | Stop A, acquire native guards on the production SQLite files, copy the main DB and any WAL into Host-owned disposable scratch, and run B's authenticated read-only maintenance preflight only on scratch. Commit B only after exact process/package/Store checks. Permit one exact A fallback before commit only with unchanged production Store evidence and proven process termination. | H1 switches before readiness and cannot safely recover B startup failure. |
| H-min-6 — Close bypass | Advertise a capability absent from H1 and refuse Engine-accessible legacy `lifecycle.activate_candidate` and any other alternate selection route in P6 mode. | Structural Judge-marker activation is not the P6 contract and could bypass current eligibility. |

This remains a real native Host and Tauri change, but does not recreate H2's P5 admission or approval system. Host/shell deployment is separate and maintainer-authorized. Until it is installed and verified, H1 refuses P6 activation.

## 6. Autonomous trigger, source, and package

P5 acceptance is the trigger, not unconditional install authority. Before build, staging, and the final switch transaction, A checks the exact handoff, current Parent/Repair/Stop/invalidation state, retention and references, installed baseline, supported change scope, and current Host capability. A Stop or invalidation before the final transaction blocks. After that transaction, Host can act only on the already bound target.

A reconstructs the exact accepted source from immutable Store objects, confirms Git/source identities, applies installed build policy, and invokes a fixed trusted builder. Candidate scripts, configuration, plugins, tools, and verification policy cannot replace that builder. Two independent builds must produce exact matching outputs. The package's actual file set is its payload manifest plus `build.json`; the Host hashes the manifest separately, while the receipt/request bind manifest and whole-package digests. Host verifies the final bytes and installed frozen shell/resources, but hashing does not independently prove compilation.

The first P6-capable Host and initial compatible Engine are installed through the separately authorized maintainer path. Existing H1 remains fail-closed. A handoff for an H1 baseline cannot be relabeled as a P6-capable handoff.

## 7. P5 enrollment continuity

The current P5 enrollment root at `profile/p5/enrollment.json` remains immutable. Before staging, A prepares a successor baseline, running-source artifact, verification-policy artifact, and P5 profile from the accepted handoff using existing P5 schemas. The successor preserves Owner-installed workspace, scope, budgets, repository identity, and publication references; only release/source-bound baseline and control-closure references advance. The build receipt binds that profile to B's exact package.

After Host commits B, its durable activation receipt remains queryable across Host restart. B writes an idempotent P6 continuation receipt after the normal Store opens without migration but before P5 admission or Engine recovery. The P5 reader follows a unique continuation chain from the immutable root, checks that non-release policy fields are unchanged, and requires the current Host-attested release to match the prepared successor. Missing, forked, stale, or mismatched evidence keeps P5 admission closed; B retries the same continuation. This avoids recurring Owner enrollment without introducing a general delegation or grant framework.

The continuation reader and writer are proposed work, not implemented. The first compatible Engine baseline must include them before automatic handoff is relied on; successful continuation must be proven across at least two Engine-only updates.

## 8. Store compatibility and recovery

P6 v1 requires the same Store migration catalog, data format, and supported record-reader contract. New or changed migrations, historical migration changes, irreversible transformations, unverified durable-state changes, or unknown compatibility block activation. No automatic migration, snapshot, database restore, or external-effect undo is permitted.

B starts first in a dedicated read-only maintenance entrypoint after A is stopped and Host has acquired native guards over the production Store. The Host copies the main DB and any WAL into disposable scratch, omitting transient SHM; B opens only that scratch copy. This entrypoint precedes runner side effects, normal Store construction, migration, recovery, API, Custody/provider work, and user-work acknowledgement. Windows experiments found that a live SQLite read-only connection changes `-shm`, permits a separate writer, and can create missing sidecars. Scratch sidecars may be created and are discarded. A present rollback journal, ambiguous file set, failed guard, or failed identity/hash recheck holds. B closes the scratch handle and remains in the same PID waiting for Host permission.

After A stops, Host captures the database/sidecar identities and file-set, then holds the existing files using Windows `CreateFile(GENERIC_READ)` with `FILE_SHARE_READ` only while it copies and B validates scratch. If B exits before Host commit, A may be restored only if B and all Custody/process trees are proved ended and every post-shutdown Store fact is unchanged. If anything is uncertain or changed, Host holds. Once Host commits B, Host releases the guards and normal runner/API startup is allowed; a subsequent failure leaves B selected for manual recovery. That limit is deliberate because postcommit writes make automatic binary fallback unsafe.

The Windows SQLite and sharing experiment is recorded in [G0 feasibility evidence](evidence/2026-10-31-p6-g0-feasibility.json). The experiment rejects live-Store preflight and supports only the post-stop guarded disposable-copy path. References: [Node SQLite `readOnly`](https://nodejs.org/api/sqlite.html), [SQLite read-only WAL requirements](https://www.sqlite.org/wal.html), and [Windows `CreateFile` sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

### 10/31 G0 feasibility amendment

The initial live-Store preflight proposal is superseded by the real Windows probe. On Windows 11 with Node 22.20.0 / SQLite 3.50.4, a SQLite read-only connection changed the live `-shm`, did not fence a separate writer, and created missing WAL/SHM sidecars. The native `CreateFileW(GENERIC_READ, FILE_SHARE_READ)` guard blocked write/delete/rename, but could not be acquired while A still held SQLite open. The minimal safe path is therefore to stop A, hold guards on the original SQLite files, copy the main DB and any WAL into Host-owned disposable scratch, omit transient SHM, and preflight only scratch. A hot rollback journal, ambiguous file set, failed identity/hash recheck, or missing guard holds the switch. Scratch is validation input only and is never restored or promoted. All dependent P6 contracts must use this amended sequence.

## 9. Decision delta

| Previous decision | New decision | Reason | Actual implementation implication | Safety consequence | Accepted trade-off | Required test |
|---|---|---|---|---|---|---|
| Two Owner approvals per release | No new approval after eligible P5 acceptance | Owner rejected repeat approval flow; accepted P5 is the trigger | Engine automatically creates one bound P6 operation | Current eligibility and fixed target remain mandatory; no grant authority exists | Less per-release human oversight; trust remains in P5/installed Engine | Accepted handoff runs without prompts; stale/Stop/invalidation blocks |
| Administrative activation authority graph | Existing P5/Engine/Host identities and receipts | Graph duplicated authority and revision state | Remove grant heads/chains; use immutable operation and command receipts | No implicit capability from an unselected artifact | No generalized revocation system for P6; Stop boundary is explicit | Replay/conflict and pre-boundary Stop race tests |
| Comprehensive H2 lifecycle extension | Minimal H-min compatibility patch | Existing Rust lifecycle capabilities can be reused | Extend Host identity, durable switch, Custody fence, read-only preflight, and bypass refusal | Exact selection and process certainty remain Host-owned | Patch is still substantial native work and requires separate deployment | Real Windows Host process/fault tests |
| Host-side P5/P6 admission adapter | Engine A verifies P5; Host verifies package/process | Host should not duplicate Self-Repair/Judge logic | Keep P5 graph and control checks in Engine; Host accepts only fixed authenticated request | Independent P5 verification is reduced and trust moves to A | Cooperative same-user trust boundary remains | Mutated handoff and changed P5 control-path tests |
| Separate Owner build and activation grants | Fixed installed builder plus exact artifact verification | Candidate must not control builder; approval grants are removed | Store-input adapter around existing trusted bundle/copy/inventory routines; two builds | Candidate scripts cannot replace installed tools or select release | Host hashes bytes but does not rebuild B | Independent exact-source builds and changed-after-verification test |
| H1 whole-desktop identity model | Stable shell identity separate from Engine identity | H1 rejects B with unchanged shell | Manifest schema and bootstrap launch identity split | Native shell remains verified while Engine can change | Existing H1 cannot participate | Installed Tauri S loading B from another root |
| Extensive probation | Precommit read-only preflight and minimal bounded Host checks | General health platform is unnecessary | Dedicated maintenance entrypoint, exact process/package/store facts, one switch | B cannot write before commit; postcommit writes are not rolled back | API failure after commit requires manual recovery | Preflight/no-side-effect and postcommit-failure tests |
| Automatic fallback on failed B startup | Fallback only before B commit with process and Store certainty | Normal startup may write the Store | Host keeps A selected until commit; only exact A can be restored precommit | Uncertain state cannot start a second Engine | No automatic fallback after the commit boundary | Fault at each Host phase; changed Store or uncertain process must hold |
| Automatic migrations / generalized data coordination | No migration or incompatible data changes in P6 v1 | No safe rollback exists for arbitrary Store mutation | Compare migration catalog and actual schema read-only before startup | Existing Store remains the only data set | Some accepted repairs are retained but not activated | Migration/schema incompatibility refusal tests |
| Separate manual P5 enrollment after every B | Host-receipt-backed successor profile and P6 continuation | Avoid hidden repeat Owner action | Extend P5 reader and idempotent pre-admission continuation | Enrollment root and non-release policy remain immutable | Continuation is a new required reader path | Two successive updates; missing/forked receipt stays closed |
| Extensive administrative API | Reuse read-only status and existing command channel | No new UI/API need shown | Add only internal fixed `stage`/`switch` commands and bounded status if needed | Stage cannot activate; switch cannot change target | No general operator console | Status is read-only; duplicate command has no repeated effect |
| Multiple candidate updates | One nonterminal update per installation | Reduces races and state without losing v1 use case | Serialize through Store receipt chain and Host lock/selector | No concurrent target ambiguity | A second repair waits until first terminal | Race two activation requests; exactly one proceeds |
| Store snapshot restoration | No snapshot restore | Snapshot can lose acknowledged/external work and is not required if no-write boundary holds | Read-only compatibility and Host file guard; hold on drift | No silent loss or external-effect replay | Some failures require manual recovery | Verify no snapshot/copy restore path is used |
| Host update through Engine Self-Repair | Separate maintainer Host/shell release only | Host is the immutable trust boundary | P6 Engine cannot invoke Host update path | Candidate cannot replace its own verifier/process supervisor | Initial P6 capability requires one separately authorized cutover | Legacy-route and Host-update refusal tests |
| UI and broad runtime update | Engine-only scope; UI, shell, runtime version, pinned dependencies frozen | UI remains embedded and independently loadable Engine boundary is absent | Reject mixed/unsupported candidate scope as a whole | No partial cherry-pick or false provenance | Some P5 handoffs remain accepted but inactive | Scope classifier tests for UI, Host, dependency changes |

## 10. Independent read-only review

The independent reviewer used a fresh context, inspected the current Rust Host, Tauri bootstrap, Engine startup/shutdown, Store, Process Custody, P5 artifacts, packaging and the revised ADR/contracts/inventory/recovery/plan. The reviewer made no edits and ran no builds or tests. After the correction pass, the reviewer reported **no remaining Critical, High, or contract-breaking Medium findings**. The review confirmed that staging precedes A's final `switch_committed` transaction; C10/C11 match same-PID preflight wait and atomic Host selection; SQLite read-only preflight and post-stop guard are distinguished; Custody is settled/fenced; the package avoids self-hashing; progress records are immutable; and P5 continuation is ordered before P5 admission/recovery.

The review conclusion is **ready with limitations**, not implementation or deployment readiness. Remaining proof obligations are the real Windows WAL/SHM and file-sharing behavior, Host restart recovery, the P5 continuation implementation, and packaged fault-hook closure. The current `DESZO_CUSTODY_TEST_FAULT` path must be inert in packaged P6 source/bundles before production reliance; P5's same-user boundary remains cooperative. In a final document/link pass, the reviewer confirmed that the 23 answers match the corrected contracts and that the separate compact decision record contains all 18 requested decisions. No P6 implementation evidence was supplied by the review.

## 11. Answers to the 23 required review questions

| # | Question | Answer |
|---:|---|---|
| 1 | Is P6 actually autonomous? | **Yes by design**, after the separate compatible Host cutover and initial compatible P5 enrollment. An eligible accepted P5 handoff triggers build and activation with no new per-release approval. Current H1 cannot run it. |
| 2 | Are all per-release Owner approvals gone? | **Yes.** No build approval, activation approval, permission prompt, or Judge decision is added after P5 acceptance. |
| 3 | Is there a hidden automatic grant framework? | **No.** There is one immutable operation and linear receipt chain bound to the handoff and exact release, not a reusable grant or authority head. |
| 4 | Is Host materially simpler than H2? | **Yes.** Host no longer interprets P5, manages grant policy, or builds source. It still needs identity split, durable selection, process fencing, preflight, and fallback. |
| 5 | Can more existing Host capability be reused? | **The proposal reuses the existing process worker, lock, IPC, state file, journal, hashing, Custody, and readiness channel.** The reviewed H1 contracts do not supply the identity split, two-phase commit, zero-Custody fence, read-only preflight, or safe fallback. |
| 6 | Does it solve H1's build-ID incompatibility? | **Yes as a proposed schema/bootstrap change.** H1 itself remains incompatible and must refuse P6. |
| 7 | Are Shell and Engine identities separated correctly? | **Yes.** Stable compiled shell identity/root is checked separately from selected Engine identity/root; readiness binds both. |
| 8 | Can B run with unchanged Host resources? | **Yes in scope.** B uses the unchanged verified shell/frozen resources and separate Engine root; changes to those resources are refused. |
| 9 | Can candidate code replace trusted build machinery? | **No under the specified fixed-builder/cooperative model.** Candidate scripts/config/plugins/tools are not run. Same-user process confinement is not claimed. |
| 10 | Can stale or invalidated P5 activate? | **No by contract.** A rechecks live eligibility through the final transaction; Host accepts only that fixed stage/switch target. |
| 11 | Does Host independently validate the artifact it launches? | **Yes for bytes, package shape, shell binding, process, and release identity.** It does not independently reconstruct P5 or rebuild B; trust for those remains in A. |
| 12 | Are Engine-accessible legacy activation bypasses closed? | **Required in the compatible Host contract.** Current H1 still has a legacy route and is therefore unsupported; H-min refuses it before effects. |
| 13 | Can two Engines run after uncertain termination? | **The intended contract prevents it.** Host requires zero Custody Jobs and proved process termination; uncertainty holds without launching a replacement. Windows execution proof is outstanding. |
| 14 | Can Host restart recover an interrupted switch? | **The state model defines recovery** from one authoritative `active.json` committed selector, profile `lifecycle.json` pending operation state, and the existing lock/journal. Crash/restart behavior remains to be implemented and tested. |
| 15 | Can failed B restore A with compatible state? | **Only precommit.** Restore exact A when all process trees ended and post-A-shutdown Store facts are unchanged. After B commit, failure leaves B selected. |
| 16 | Can B modify SQLite before readiness and make fallback unsafe? | **Not before Host commit by design.** Maintenance preflight is read-only and normal startup begins only after commit. A postcommit write/startup failure has no automatic rollback. |
| 17 | Are recovery states minimal but sufficient? | **The proposal uses one Host operation/selector and immutable Store receipts.** C01–C18 remain mapped. Sufficiency still requires the Host fault tests. |
| 18 | Can B continue P5 without manual approval? | **Defined, not implemented.** Host receipt and P6 continuation advance an effective enrollment from immutable root; missing or invalid continuation closes P5. |
| 19 | Does it avoid unnecessary API and Store extensions? | **Yes in scope.** No new DB/table, updater API, or Host-side P5 adapter; use existing Store artifacts/command receipts and internal authenticated Host commands. A P5 reader extension is required. |
| 20 | Is Host immutability preserved? | **Yes.** Host/shell changes require a separate maintainer release and are never carried out by P6 Self-Repair. |
| 21 | Are Windows packaging and executable identity constraints addressed? | **Specified.** Stable shell identity, separate Engine root, exact package/file-set verification, and Windows file handles are defined. Real installed proof remains outstanding. |
| 22 | Are safety claims stronger than guarantees? | **Limits are explicit.** There is no arbitrary semantic compatibility proof, OS sandbox, external-effect undo, snapshot restore, postcommit fallback, or claim that H1 is compatible. |
| 23 | Is the implementation plan concrete and small? | **Yes for the architecture task:** four stages—Host patch, automatic trusted build, Engine switch/P5 continuity, and real Windows E2E. Each stage still represents unimplemented engineering work. |

## 12. Compact P6 decision record

| Decision | Required outcome |
|---|---|
| Self-update trigger | Accepted, currently eligible P5 handoff |
| Human approval | No new approval |
| Trusted build owner | Current installed Engine using the fixed trusted builder |
| Source identity | Exact accepted P5 source and immutable Store objects |
| Candidate verification | Installed trusted Engine A; changed control paths meet existing `repair-authority` floor |
| Release artifact verification | Host verifies exact staged bytes, file set, manifest, shell binding, and process identity |
| Engine switching | Rust Lifecycle Host |
| Host update | Never through Self-Repair; separate maintainer release |
| Host patch | H-min-1 through H-min-6 above; H1 remains fail-closed |
| Release scope | Engine-only initially |
| UI activation | Unsupported until independent UI loading exists |
| SQLite migrations | Unsupported in automatic P6 v1 |
| Readiness | Dedicated read-only bounded preflight before commit; normal API health follows commit |
| Fallback | Exact A only before B commit, with process certainty and unchanged Store facts |
| Durable state | Multiple grants, selected heads, and extensive operation state | Existing P5 objects, one immutable P6 intent and receipt chain, one Host `active.json` committed selector, and profile `lifecycle.json` pending operation state |
| P5 continuity | Immutable root plus Host-receipt-backed continuation; no recurring Owner approval |
| Host H1 | Unsupported; fail closed |
| P6 implementation readiness | Ready with limitations as an architecture; not implemented or deployed |

## 13. Completion status

- [x] ADR-0010 proposes automatic P6 and remains Proposed.
- [x] Per-release Owner build and activation approval are removed; no substitute grant framework is introduced.
- [x] Host responsibilities and the H1 blocker are explicit; the minimum compatibility contract is specified.
- [x] Stable shell and changing Engine identities are defined.
- [x] Exact P5 source, trusted build, Host package verification, and immutable Host boundary are preserved.
- [x] Legacy bypasses, migration incompatibility, process uncertainty, Host restart, and P5 continuation have explicit contracts.
- [x] Original C01–C18 recovery coverage is reconciled in the matrix.
- [x] Dependent architecture documents are updated and linked.
- [x] Independent read-only review found no unresolved critical, high, or contract-breaking medium design finding.
- [x] No P6 production functionality was implemented; no tests or builds were run for this architecture task.

The architecture is ready to proceed to implementation **with the listed limitations and proof obligations**. This verdict does not authorize deployment or imply that H1 supports P6.
