# Historical review: superseded approval-based P6 proposal

> This independent review assessed the earlier Proposed ADR-0010 architecture with per-release Owner approvals, grants, selected authorization heads, and broad H2 admission/probation contracts. Its `P6 ARCHITECTURE NOT READY` verdict applies only to that superseded snapshot. The Owner later directed the minimal autonomous revision; the current architecture and fresh review are in [the simplification review](2026-10-30-p6-architecture-simplification-review.md). Keep this record for its historical findings, not as the current P6 verdict.

# P6-ARCH — Independent architecture review

Date: 2026-10-30 (Europe/Moscow). Source baseline: `1f54c47fe265c6b47bf36695be56214056fc3af1`.
Status: independent read-only review and two correction rechecks complete. ADR remains Proposed.

**Independent final verdict: `P6 ARCHITECTURE NOT READY`.** All specification findings below are closed; current H1
cannot satisfy the installed-desktop path, and G0 is unimplemented, unverified and undeployed. Contract review does not
waive that deployment prerequisite or constitute project architecture acceptance.

## 1. Review method and evidence

The primary author requested a separate fresh-context reviewer with no inherited conversation history. That reviewer
read the complete proposed [ADR](../adr/0010-p6-trusted-build-activation-rollback.md),
[inventory](2026-10-30-p6-existing-capabilities.md), [contracts](2026-10-30-p6-contracts.md),
[recovery matrix](2026-10-30-p6-recovery-matrix.md) and [plan](2026-10-30-p6-implementation-plan.md), independently checked
repository evidence, returned findings and all 25 required answers, then re-read corrections in two passes.

The reviewer inspected the Rust [lifecycle core](../../lifecycle-host/src/lib.rs),
[Custody](../../lifecycle-host/src/custody.rs), [Tauri shell](../../src-tauri/src/main.rs),
[configuration](../../src-tauri/tauri.conf.json), [runner](../../runtime/runner.mjs),
[Engine](../../runtime/core/engine.mjs), [Store](../../runtime/core/store.mjs), P5/current schemas,
Host packaging/provenance/bridge implementation and desktop/runtime bundlers, alongside ADR/P5 closure evidence.
The review made no file/Git changes and ran no builds, tests, installed application or production workflow. Documentation
checks performed by the primary author are separately reported in the plan; they are not lifecycle acceptance evidence.

The proposal was frozen for each semantic review pass. The only change during the first read was ADR list blank-line
formatting; the reviewer explicitly re-read the current snapshot. Later corrections were reviewed after a new freeze.
This final record summarizes those returned findings and conclusions without claiming another implementation audit.

## 2. Findings and corrections

| ID | Severity | Finding | Final disposition / exact proposed correction |
|---|---|---|---|
| R1 | High | H2 left the legacy `lifecycle.activate_candidate` route capable of bypassing P6 source/Owner/seal/probation checks | **Closed.** Contracts §11 explicitly refuses legacy schema-1/structural-Judge activation before stop/copy in managed mode. Every alternate Engine selection path enters P6 or refuses; maintainer deployment has distinct non-Engine authority. G0 negative test preserves A PID/selection |
| R2 | Contract-breaking Medium | C06 had no pre-copy staging phase; completed stage/budgets were required too early | **Closed.** Contracts §8/§11 add `staging`, synced StageIntent before creation, allocation proof before copy, separate stage budget and nullable completed-stage/lifecycle fields. Unknown post-create/pre-allocation directories hold |
| R3 | Contract-breaking Medium | Final authorization revision lacked a committed head, membership and rebind encoding | **Closed.** Contracts §3/§10 define separate selected build/activation heads, immutable predecessor chains, atomic receipt/operation CAS membership, exact sealed heads and constrained pre-quiescence binding. Unselected artifacts confer no authority |
| R4 | Contract-breaking Medium | One operation fingerprint could not express stage/prepare/activate command replay | **Closed.** Contracts §11 separates immutable proposal hash from per-command request ID/full-envelope digest and retained command-result indexes. Duplicate lookup precedes fresh epoch/CAS checks; replay never repeats effects |
| R5 | Contract-breaking Medium | Unsealed A restoration, sealed fallback and committed restart lacked complete readiness/workload-release rules | **Closed.** Contracts §12 defines four launch purposes, native launch/workload grants, stable generations, RestorationReceipt without a fabricated seal, actual-target health and admission for every role |
| R6 | Contract-breaking Medium, second pass | Ordinary committed-A restart was ambiguous while staging/staged/prepared remained nonterminal | **Closed.** Contracts §12 explicit phase table permits safe pre-quiescence A restart while retaining update/history/budget; exhausted update-only budgets do not block safe unchanged A. Monotonic `quiescenceStarted` prevents recovery-limit bypass after stop; process/profile uncertainty always holds |
| R7 | Contract-breaking Medium, second pass | A new native slot identity still required an Engine Store artifact during Host-only staging completion | **Closed.** Contracts §8 makes native identity/file-set proof HostRef, uses the pre-existing expected Store inventory and requires exact later Store mirroring of the authoritative Host receipt |
| L1 | Lower | Lifecycle budget timing differed between ADR/API, with no persisted clock state | **Closed.** Lifecycle limits captured before prepare/stop; build/stage limits separate. Typed boot-ID/uptime/wall/counter evidence charges downtime and never resets pending budgets |
| L2 | Lower | Isolated current-state validation was both mandatory and optional | **Closed.** Current stopped-profile copy/reader validation is mandatory before seal; its Host proof is distinct from earlier representative build tests |
| L3 | Lower | Prose promised inline selection identities while state contained only Store refs | **Closed.** Host state contains complete inline committed/previous/pending identities and stable committed generation; refs retain provenance. Installation-wide state is the sole selector |
| L4 | Lower | Generic granted-head wording appeared to prohibit cancellation or unchanged-A safety recovery after revocation | **Closed.** Granted-head requirement applies to advancing B; selected revocation/cancel and narrowly captured unchanged-A recovery are explicit exceptions, with no revived candidate authority |

The primary author also separated observed test outputs from StatePolicy/HostCompatibility input records to avoid
output/input hash cycles. The reviewer confirmed that correction and found no additional blocker in source/build
identity, revocation, command replay or workload-grant interactions.

**Final correction recheck:** all five original findings, both follow-up Mediums and lower findings are closed in the
proposal. No remaining Critical, High or contract-breaking Medium specification issue was found. These are read-only
contract conclusions, not claims that H2, P6, production fault gating or Windows acceptance has been implemented.

## 3. Confirmed current deployment blockers

| Blocker | Independently checked source | Consequence |
|---|---|---|
| B1 — shell/Engine identity coupling | `lib.rs` `verify_build` (line 1089 onward) requires schema 1 and desktopBuildId==buildId; shell validation at line 55 requires compiled ID | A's unchanged executable cannot satisfy B's selected identity; runtime substitution is also refused |
| B2 — independent P6 build/admission authority absent | Rust dispatcher at line 1472, `accept_operation` at 1865, existing fixed/legacy build paths | Structural Judge marker is not P6 approval; H2 must close the old route and supply trusted consumer/builder/admission |
| B3 — probation/fallback/commit absent | Replacement worker at line 1954; post-stop copy and pre-readiness switch; `accept_ready` at 1764 | Current failed startup retains B; Engine ready report alone is insufficient |
| B4 — pre-write state/startup maintenance absent | Store constructor/migrate at line 24; Engine initialization at 180; runner initialization/ready before HTTP listen | Current startup may migrate/reconcile/dispatch before proposed Host verification; the new maintenance/data gate requires infrastructure and Engine work |

No installed H2 executable/configuration/capability evidence was supplied or measured. A hypothetical future implementation
cannot be treated as an installed capability. The reviewer agrees with refusing current H1 activation and requiring a
separate normal maintainer Host/shell release, compatible initial Engine baseline and fresh P5 enrollment/handoff.

## 4. Mandatory review answers

| # | Question | Final answer after correction |
|---|---|---|
| 1 | Reuse Lifecycle Host? | Yes. Same Rust core, ownership lock, Jobs, IPC, durable state/journal; H2 additions are explicitly proposed |
| 2 | Avoid a second source identity/Store? | Yes. P5 complete source digest remains authoritative; release inventory/package hashes are distinct projections. Generic Store receipts and existing Host journal are reused |
| 3 | Host truly immutable? | Yes in the selected managed contract: shell/native/bridge/legacy resources and effective input closures stay fixed. G0 is a separate maintainer release; legacy Engine selection bypass is closed by specification |
| 4 | Engine/UI boundary accurate? | Yes. Node runner is external; React UI is embedded in Tauri. Arbitrary UI activation needs a separate shell release; shared Host source inputs remain protected |
| 5 | Installed Host can activate the format? | **No on H1.** Schema/build-ID coupling blocks the proposed unchanged-shell Engine envelope; no deployed H2 proof exists |
| 6 | Old Engine can die? | Existing worker survives requesting Engine death. Proposed Host owns preparation/seal/probation/commit/recovery; source/command/status observations do not make Engine a second selector |
| 7 | Exact source through build? | Specified: complete Store bytes/modes, exact Git identity, source projection and complete trusted inputs. Current packager needs the acknowledged Store-input adapter |
| 8 | Candidate scripts can replace Host artifacts? | Prohibited on managed paths by fixed builder, Host source/artifact closure comparison and explicit closure of every legacy selection route. Same-user hostile filesystem confinement is not claimed |
| 9 | Trusted builder identified? | Yes: separately deployed, pinned local helper under existing Rust Custody. Production P6 implementation is absent |
| 10 | Every installed artifact verifiable? | Proposed exhaustive path/size/hash/package checking and mixed provenance cover all files. H1's existing manifest checking is weaker |
| 11 | Candidate self-certifies activation? | No. Ready is evidence only; Host independently checks target/process/data/API health and atomically commits/grants workload. H1 does not yet meet that contract |
| 12 | Activation authority distinct from P5? | Yes. Explicit Owner build and activation grants; no fabricated P5/Judge install authority or automatic policy |
| 13 | Stop/revocation consistent? | Yes after head-chain correction. Stop before seal wins; token rotation differs from grant revocation; compensation cannot revive B authority |
| 14 | Concurrent requests activate different versions? | Prevented in the proposal by one Store operation, installation lock, exact proposal/command identities, selected heads and generation/revision/baseline CAS |
| 15 | Readiness stronger than process existence? | Yes in the proposal: initialized compatible Store/projections, authenticated read API, actual target identity and bounded repeated health |
| 16 | Roll back after SQLite schema change? | V1 refuses schema/data-format changes before constructor writes. Incompatible observed mutation holds for manual recovery; old binary is not blindly launched |
| 17 | State restoration loses acknowledged work? | Automatic live restoration is excluded. Fallback keeps current compatible data; isolated copy is validation only |
| 18 | External effects excluded? | Explicitly. Binary fallback cannot undo external actions or authorize replay of uncertain provider commands |
| 19 | Failed rollback duplicates Engines? | Proposal requires whole-writer termination, stable recovery IDs and one issued launch. Uncertain/failed recovery holds; ordinary startup cannot bypass pending counters |
| 20 | Survive Host/Engine restart? | Exact IDs, immutable command/outcome records, role-specific startup/admission and persisted budget/phase rules are specified. Unknown process/state/time facts hold |
| 21 | Crash boundaries durable? | C01–C18 are mapped to actual/proposed owners, including stage intent/allocation, selected authority heads and recovery roles. No passing P6 fault execution is claimed |
| 22 | Windows replacement constraints? | New inactive directories, native identity/reparse checks, sync and same-volume finalization; no running executable overwrite. Real Windows proof remains required |
| 23 | R6 import closure? | Effective baseline/candidate control closure, actual bundler resolution/generated modules and pinned externals; changed reachable inputs require existing repair-authority coverage |
| 24 | Production fault hooks excluded? | Required for both bundle and shipped support/source using a non-environment production gate. Current env-enabled hooks remain a named G0/acceptance dependency, not an implemented fix |
| 25 | Appropriately scoped v1? | Yes: Engine-only, frozen UI/Host/dependencies, no migrations/live restore, explicit Owner action and bounded precommit fallback. Compatible deployment is still missing |

## 5. Disposition

The architecture packet is reviewable and its internal specification findings are closed. It must **not** receive
`P6 ARCHITECTURE READY FOR IMPLEMENTATION` under the requested installed-Host criterion. Final verdict:
**`P6 ARCHITECTURE NOT READY`**. Keep ADR Proposed and H1 activation closed; G0 requires separate implementation,
verification and manual deployment. No P6 production functionality was implemented by this architecture work.
