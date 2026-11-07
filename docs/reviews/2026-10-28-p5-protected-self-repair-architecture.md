# Deszo P5 — Protected Self-Repair Architecture

**Date:** 2026-10-28 (Europe/Moscow)

**Task:** Architecture and contract design only; no P5 implementation or execution.

**Audited source:** `a41d03ffedf9ce55aab3e791d4e193f3bda0127d` (`P4`).

**Decision status:** Proposed P5 design under the current documentation authorization. Existing ADR acceptance is unchanged.

**Verdict:** `P5 ARCHITECTURE READY FOR IMPLEMENTATION` within the explicitly bounded supported profile (§§15, 21).

## 1. Executive summary

Select **Option A: an explicitly enrolled, separately published sequential Repair workflow using P2 coordination, P4 Judges and the existing Rust Process Custody Host**. Add source capture, a deterministic verification execution binding and candidate-bound acceptance checks to those paths. Do not add a Repair coordinator, scheduler, supervisor, artifact store or approval service.

The initial source policy is **clean committed base, regular files, local stable filesystem topology**. Capture committed Git objects as immutable source artifacts, materialize a private directory without `.git`, let the Developer edit that directory, independently inventory the actual result, and seal its bytes in the existing object store. Verify a fresh materialization of those sealed bytes using a plan and harness captured outside candidate control. The Repair Judge can accept only a complete passing receipt for that exact candidate. P2 alone applies its captured Parent continuation rules. Retain accepted source and evidence for P6; P5 never applies a patch to the original checkout, publishes a Git ref, activates a binary or replaces the running Engine.

The security claim is deliberately bounded. Engine-managed operations preserve user files and enforce source scope and acceptance. A worktree, private directory, separate Agent or Windows Job does **not** confine arbitrary same-user Full Access code. **AR01 remains accepted.** The supported profile assumes cooperative managed code and integrity of the running Engine, Host, installed verifier and store; hostile commands, hostile dependencies and an adversary changing filesystem topology are outside that assurance. Missing required identities and observed violations fail closed. No new mandatory OS isolation is imposed on existing P1–P4. A deployment needing hostile-code protection must supply separately proven OS isolation before enrolling that execution profile.

Seven separate facts must remain visible:

| Fact | Authoritative evidence | Does not authorize |
|---|---|---|
| Proposed fix | Developer output, explicitly untrusted | Any state transition by itself |
| Candidate source captured | Engine source manifest and verified content objects | Verification success |
| Verification finished | Host terminal/tree/spool evidence and complete check observations | A different source digest |
| Exact candidate verified | Engine-issued passing verification receipt | Judge acceptance |
| Repair Judge accepted | P4 decision and P2 approval artifact bound to P5 evidence | Parent retry beyond P2 policy |
| Parent may continue | Existing P2 continuation CAS and P3 effect-certainty gates | Build, installation or restart |
| Build/activation permitted | A later P6 decision under its own contracts | Not supplied by P5 |

All names beginning `ProtectedSelfRepair`, `P5`, `self_repair.` or `self-repair-verify` below describe **proposed** contracts. None is claimed to exist in the audited code.

## 2. Problem, goals and non-goals

P5 must turn a source modification into a durable, verifiably identified repair candidate while keeping source, execution and decision authority distinct. It must preserve unrelated user changes, survive Engine replacement, retain uncertain workspaces, and expose enough evidence for independent acceptance and later P6 consumption.

Goals: exact baseline and candidate identity; isolated Engine-managed writes; preselected independent checks; source-bound evidence; one designated Repair Judge; Stop precedence; idempotent reconciliation; finite budgets; inspectable retention and handoff.

Non-goals: automatic incident triggering (P7), production build attestation or activation (P6), upgrading the installed Host, general infrastructure maintenance, arbitrary hostile-code sandboxing, dirty-source reconstruction, general workflow language expansion, mandatory full regression on every experiment, or claiming that tests prove an arbitrary program correct. Test compilation into disposable verification scratch is allowed by a future captured verification plan; it creates no deployable P6 approval.

## 3. Current implementation audit

The audit reads the current source, not only historical reports. Function names below are navigation anchors; §23 records the baseline and source hashes.

| Mechanism | Existing evidence | Reuse / precise P5 gap |
|---|---|---|
| P1 continuation | `engine.mjs`: `initialize`, `recover`, `publishedDefinitionIntact`, restart gates and state rebuild; `runner.mjs` runner lock and runtime identity | Reuse the same Run/Attempt and startup path. P5 preparation, seal and deterministic verification must become recoverable steps in that path. |
| P2 coordination | `linkedRepair.mjs`: `startWorkflowJudgeRepairInTransaction`, `logicalRepairLinkIntact`, `recordLogicalRepairOutcome`, `resumeLogicalRepairParent`, `reconcileContinuations` | Captures exact publications, incident, authorization/checkpoint, workspace IDs and retry policy; unique incident/link and CAS transitions. No source manifest or source verification gate exists. |
| P2 adaptive result | `applyWorkflowJudgeRepairApprovalInTransaction` and M22 | Recomputes the named successful Agent/Text **text** digest and checks named verification Attempt/output records; persists `AdaptiveRepairJudgeDecision`. Those facts do not identify changed files or establish independent tests. |
| P3 outcomes | `failureOutcomes.mjs`, `failure_outcomes` M20; bounded Engine evidence reads | Reuse provenance, revisions and execution/effect certainty. Do not reinterpret full transcripts. Use P5 status codes in P5 artifacts, with existing canonical P3 errors. |
| P4 policy and admission | `validate.mjs`, `workflowJudgePublicationIssues`, `workflowJudgeRuntimeAvailable` | `workflow-judge/1`, exact designated Agent, captured Repair profiles, no nested Repair. Runtime requires Custody, excludes Loop/Map/Task and Context Agents; also excludes the legacy `hostAuthority`/verification-only execution path. |
| P4 authority and recovery | `workflowJudge.mjs`: context/cursor/evidence, finalize, atomic decision application, questions; `custody.mjs`: Judge reattach | Reuse attention, bounded evidence and live Attempt authority. P5 must add its subject/receipt to the cursor and deterministic approval checks; a role marker grants nothing. |
| Physical workspace roots | `workspaceIsolation.mjs`; P2 admission, dispatch, launch and continuation guards | `realpathSync.native` and component overlap reject equal/nested/alias roots. This is neither a durable OS file-handle binding nor filesystem confinement. |
| Process ownership | `custody.mjs`, `lifecycle-host/src/custody.rs`, M16–M18 | Host admits a canonical executable/digest with one-use launch permit, epoch/generation fencing, spool and tree terminal evidence. Engine holds workspace before launch. Engine's resumable path currently recognizes plain top-level **Agent** Attempts only. |
| Git/source delivery | `branchDelivery.mjs`, `taskRuntime.mjs` | Private clone, hooks policy, manifest digests, before/after checks, awaited cancellation and CAS ref publication exist. Delivery ultimately commits/fetches/updates a ref and is a Managed Task path: **do not invoke it as P5 delivery**. No general recoverable P5 worktree manager exists. Reuse safe helpers and conventions, not that publication operation. |
| Source provenance | `runtime/host/sourceProvenance.mjs`, `buildAttestation.mjs`, `buildRunner.mjs` | Existing SHA-256 file inventory, Git tool identity, authority import closure, exact-command and pre/post source checks are useful patterns. `sourceInventory` includes tracked/untracked effective files and is not the selected clean-commit P5 contract. Legacy native build authority is not a P4-compatible verification service. |
| Artifacts/journal | `Store.putBytes/putJson/readBytes/verifyRef`, `appendEvents`; `canonical.mjs` | Content objects are staged/flushed/renamed; read verifies size/digest; JSON is strict/canonical; `BEGIN IMMEDIATE` serializes durable transitions. Reuse all. Bytes are immutable by contract and verified on read, not OS tamper-proof against their user. `putBytes` alone does not validate an already existing object's contents: verify before authorizing it. |
| Execution recording | `streams.mjs` `StreamRecorder`, Agent settlement, `taskProcesses.mjs` | No `runtime/core/flightRecorder.mjs` exists. Existing streams, command/evidence artifacts and Custody replay supply the audit. Task commands are not P1-resumable Custody verification Attempts. |
| UI/MCP | `runner.mjs` public artifact/provenance/range and question routes, `mcp/bridge.mjs`, `src/App.tsx`, `Inspector.tsx`, `types.ts` | Existing Run/events/artifact views and typed questions are sufficient transport. Add a bounded P5 Run projection and labels; no general self-repair/approve/activate model command. |
| Cleanup | `branchDelivery.mjs` hooks cleanup, `test-roots.mjs`, native Windows review | Ownership, real-directory checks and termination deferral exist, but allocation check followed by recursive deletion has a known non-atomic check-to-delete interval. Do not elevate it into candidate promotion or automatic recursive P5 deletion. |

The P4 acceptance report records Node **909/909**, Rust **23/23**, **13/13** P4 E2E scenarios, docs/build success and no blocking independent review findings. These are historical P4 results, not tests run for this task or P5 implementation evidence. Earlier P1/P2/P3 reports describe their own baselines and limitations; later P4 acceptance does not erase their historical records.

## 4. ADR and decision status

`docs/DECISIONS.md` is the acceptance register. ADR-0001–0005 are Accepted; ADR-0006–0009 remain Proposed, with separately accepted Windows direction and subsequent implementation authorizations. P1–P4 source exists even though enclosing ADR acceptance has not been silently changed.

| Decision | P5 treatment |
|---|---|
| ADR-0002 audit/Stop | Preserve root Stop, ownership evidence and complete/partial capture distinctions. |
| ADR-0003/0004 | Preserve hard bounds, structured artifacts and explicit provider/model choice. No paid fallback or unbounded context. |
| ADR-0005 | Borrow exact-content/delivery principles. P5 does not run its commit/ref publication sequence. |
| ADR-0008 / AMD-08 protected Self-Repair | Its proposed `kind='system'`, installed manifest, protected review prompt and outside-candidate harness are design context, **not existing enrollment or isolation**. Initial P5 enrolls an exact ordinary publication using an external installed enrollment manifest; a future system-publication lifecycle is not required. P6-related build/activation language remains outside P5. |
| ADR-0009 and P4 CP-01–CP-05 | Reuse atomic failure/attention settlement, Judge-only scheduling, decision/effect transaction, Parent-versus-Repair authority and Repair-originated questions. P5 adds deterministic prerequisites, not another Judge protocol. |
| AR01 / AMD-18 | Same-user Full Access can read accessible Owner credentials and call public Owner APIs. Scrubbing environments does not authenticate a human or stop arbitrary filesystem/API access. This accepted risk is explicit in §15. |
| Native Windows lifecycle review | Preserve awaited process termination and SQLite disposal fixes. Its check-to-delete race remains; P5 uses retention and no promotion/delete operation to avoid widening it. |

The present request authorizes this design and a fresh-context read-only review. It does not authorize production implementation, new SQL, staging, commits or any actual Repair Run.

## 5. Architecture alternatives

| Criterion | A — P2/P4 workflow + protected candidate | B — Engine-internal repair subsystem | C — External repair supervisor |
|---|---|---|---|
| Authority | Existing captured profiles, designated Judges, deterministic additional gates | Must reproduce role/approval and privileged edit contracts | Adds service credentials, admission and cross-service decision authority |
| User workspace | Private source materialization; no source publication | Same protection still needs explicit design | Separate process is not itself filesystem isolation |
| Durability | Existing Runs, Attempts, link, artifacts, journal | New state machine risks diverging from P2 | Cross-store/cross-service consistency needed |
| Crash recovery | P1 Custody reattachment and P2 reconciliation | Must reconnect to those mechanisms or duplicate them | Adds startup ordering and supervisor recovery |
| Independent verification | Captured external harness, Host-owned command, Engine receipt | Can implement same checks, but cannot make internal model edits trusted | Independence only if deployed under an actually separate trust principal |
| Implementation | Narrow source/verification/acceptance additions | Larger orchestration surface | Largest deployment/control surface |
| Operations | Existing Host plus an installed verifier closure and dedicated workspace slot | More hidden Engine behavior to inspect | Another long-lived process and lifecycle |
| P1–P4 fit | Direct, with one explicitly bounded verification-Custody extension | High risk of parallel orchestration | Unnecessary second supervisor/coordinator |
| P6 handoff | Content artifacts + linked approval, independently checkable | Possible, with duplicated contracts | Requires extra inter-service handoff identity |

**Select A.** Repository evidence exposes gaps in source capture and verification execution, not a need to replace P2/P4. B is rejected as a competing workflow/Repair implementation. C is rejected because a second same-user service would add complexity without an OS protection guarantee.

## 6. Selected workflow and supported execution profile

### 6.1 Enrollment and graph

Owner enrolls source identity, an empty dedicated workspace slot, exact Repair publication, immutable verification plan, harness identity and an allowed Parent publication/profile through an explicit installation/configuration step. That installation-owned enrollment manifest resides outside candidate roots. It is loaded as trusted Engine configuration, content-verified and captured into the Run authorization. Ordinary model output cannot create or change it. This is policy/configuration, not another SQL authorization registry. Under AR01 its same-user file protection is an explicit trust assumption, not an OS secret boundary.

The managed profile stores this manifest at `profileRoot/p5/enrollment.json`; the `p5` directory and manifest must be plain objects beneath the canonical Host profile root. The Engine only loads it after Host readiness and a current Custody attachment. It verifies all referenced Store objects and asks the Lifecycle Host for the active package identity; a P5 reader refuses when that exact package/build/source tuple differs from the enrolled `ProtectedSelfRepairRunningSourceRelease/1` artifact. The Host re-hashes the complete active package and rechecks the lifecycle generation around the result.

The Parent's existing `judgePolicy.repairProfiles[]` gains one optional **`selfRepair: ArtifactRef`** pointing to a strict `ProtectedSelfRepairProfile/1`. It pins the enrolled source baseline and all P5 requirements. The Repair publication has `workflow-judge/1`, no child repair profiles, one Developer Agent, one deterministic verification Gate, and one isolated designated Repair Judge. Developer remains the P2 result node; its text artifact remains an untrusted narrative, not the P5 candidate.

**Construction order avoids digest cycles.** First create source baseline, trusted running-source release identity and verification-policy/input-template artifacts; then the Repair publication; then the P5 profile that references that publication; then the Parent publication containing the profile ref; finally the installed enrollment manifest that authorizes that Parent publication/profile. P5 publications may be constructed before enrollment because publication alone grants no Run/P2/Gate authority; runtime admission remains blocked until the exact installed manifest and Host proof load. The profile contains an `enrollmentId`, not the digest of a manifest that contains the enclosing Parent publication. It never contains its own Parent publication digest or future Run/incident/source-binding IDs. At Parent capture/request time the Engine creates source-binding and authorization artifacts binding the actual Parent/Repair Runs, publication digests, installed enrollment manifest and incident. These per-admission bindings supply those later identities throughout the contracts below. There is no self-referential JSON hash.

```text
Parent P4 failure attention + captured source binding
  -> designated Parent Judge: request_repair(profileId)
  -> existing P2 transaction: suspend Parent, capture Repair + link
  -> Engine: prepare enrolled candidate source
  -> Developer Agent (ordinary top-level, explicit provider/model)
  -> Engine: require tree ended, inventory + scope check + seal source
  -> Gate(mode=self-repair-verify): deterministic Host-owned verifier
  -> Engine: complete receipt + exact subject gate
  -> designated Repair Judge: accept_repair / reject_repair / wait / question
  -> existing P4 decision transaction and P2 approval/outcome
  -> existing P2 Parent continuation rules
  -> retained P5 source handoff for a later P6 request
```

Wire an ordinary Text/Prompt input to Developer, graph `after` Developer → Gate, and Gate `report` → ordinary Result Viewer. This supplies the existing validator's required output sink and a sequential path for every ordinary node. Judge stays an isolated control Agent admitted by P4 attention, with no ordinary graph edges. P2 profile names the Developer result node and verification Gate. No Loop, Map, Managed Task or Context-bound Agent is admitted. No optional Agent reviewer is necessary initially: mandatory semantic review is the Repair Judge, supplemented by deterministic checks. A later ordinary reviewer would supply advisory data only and would need the same source drift checks.

### 6.2 Necessary bounded extension

Current Gates are synchronous prepare/evaluate/verify utilities, and current Custody recovery resolves only top-level Agents. The proposed **`gate.config.mode='self-repair-verify'`** is a new mode on the existing Gate type, with `verificationPolicy: ArtifactRef`, no user-supplied data inputs or shell command, and `report: JsonValue` as its only output. Engine obtains its candidate and resolved inputs from the exact P2 authorization/P5 journal binding, never from a caller-controlled input port. It is asynchronous and binds one ordinary Gate Attempt to one trusted verifier process under existing Custody. It is legal only inside the exact enrolled P5 Repair Run. A standalone Gate or role marker cannot acquire this binding. Both Parent and Repair publications declare proposed capability `protected-self-repair-v1` (Repair also retains `pipeline-v1`); only a runtime advertising and enforcing that capability may admit or resume them.

This is the one indispensable execution extension: existing Managed Task command execution is outside the supported P4 profile and cannot prove verification continuation after Engine replacement. Extend Custody eligibility, invocation reconstruction, stream settlement and P1 restart eligibility **only** for this enrolled top-level Gate mode; all other non-Agent cases retain their existing behavior. It shares the normal scheduler, Stop registry, resource locks, Attempt state, Host protocol and hold reconciler. The Rust Host already accepts a configured absolute executable/digest and arbitrary provider label; no new Host command or supervisor is required. Installer must explicitly allowlist the verifier runtime, not widen it from a candidate.

This extension is proposed, not a claim that P4 currently runs such Gates. P5.3 cannot close without real Host proofs for it and regression proofs retaining P4's existing supported profile.

### 6.3 Roles

| Actor | Responsibility / limit |
|---|---|
| Owner control | Enroll exact scope, source and verification policy; Stop/close; answer only the originating Judge's typed question. Existing bearer semantics remain. |
| Parent Judge | Select an already captured eligible profile for this P3 incident. Cannot author a command, scope, workspace or new policy in its decision. |
| Developer | Change `source/` in its assigned slot and explain the proposal. No P4 decision, question, verification-receipt or lifecycle authority. |
| Verification Gate / installed harness | Execute only the captured plan and report observations for a frozen source identity. No model inference, Owner credential or approval authority. |
| Repair Judge | Assess defect fit, scope, risks and trusted observations; accept/reject only its current Repair. Semantic questions use P4's root/origin arbitration. |
| Engine | Capture policies, perform source/path checks, write manifests/receipts, enforce prerequisites, transact P4/P2 effects and reconcile. Never import candidate code into its own control process. |
| Rust Host | Admit/launch exact executable, own descendant tree, deadline/Stop/spool and epoch fence. Does not decide source acceptability or interpret Judge reasoning. |
| P6 | Independently validate the later handoff and its own build/activation requirements. Receives no implicit execution grant. |

## 7. P5-01 — Source baseline and identity

### 7.1 Initial clean-base policy

Choose clean committed base over dirty snapshot. Dirty snapshots would require tracked/index/worktree three-way semantics, explicit untracked/ignored inclusion, secret review, filter semantics and more recovery identities. They are deferred. No stash, reset, clean, automatic stage/commit or user-file removal is permitted.

At enrollment capture a full commit ID and Git object format, commit tree, canonical Git common-directory identity and an Engine-assigned repository enrollment UUID. Repository identity is `{enrollmentId, canonicalCommonDirectory, nativeDirectoryIdentity}`; remote URL/name is descriptive only and never an identity or fetch instruction. Also retain the exact canonical working-tree root and closed include/exclude/secret selector object in the baseline manifest. These are capture locations/policy data, not substitutes for the common-directory identity or the P5 source digest. A moved/replaced root needs explicit reenrollment, not path guessing.

The immutable source path policy declares the complete **effective source** consumed by P5, allowed mutations, explicitly excluded material and sensitive categories. Read the pinned commit's tree/blobs using a pinned Git executable with sanitized Git configuration/environment, hooks/fsmonitor/maintenance disabled and no filters, checkout hooks, submodule recursion, LFS download or network fetch. P5 must not execute `.gitattributes` filters to construct its baseline. Reject symlink/gitlink entries and unresolved LFS pointer inputs. For initial P5 exclude Git metadata, installed dependencies, runtime/profile state, credentials, `.env*`, local npm credentials, build output and historical test roots; do not silently omit an input a check actually reads. A source requiring an excluded file is ineligible until an explicit safe input is captured separately. Tracked secrets cause enrollment refusal and are never automatically copied.

Clean means no staged or unstaged tracked modifications anywhere in the source checkout, and no untracked non-ignored files inside the captured source inclusion set. Untracked files outside that set are recorded only as excluded path/count diagnostics, not copied. Ignored local outputs/secrets may remain; no check can depend on them. Compare included tracked working bytes to committed blobs as well as using read-only Git status, so assume-unchanged/skip-worktree or checkout transforms cannot silently invent effective identity. An intentionally transformed checkout is unsupported initially. Recheck HEAD/tree/status and included-byte identities before completing baseline capture. No source process is launched in that repository. A dirty source refuses P5 admission without modifying it; Parent may retain its normal P4 wait/question path.

### 7.2 Running-source and Parent binding

The Parent workflow publication is not the Deszo application's source identity. Keep both. A P5-enabled Parent capture stores an Engine-generated `ProtectedSelfRepairSourceBinding/1` artifact/event: Parent Run/publication/snapshot, enrolled source baseline, installation/profile identity, active lifecycle generation and trusted running-source provenance reference. The enrollment manifest must identify the source release represented by the running Engine (or explicitly enrolled source-mode runtime), including its executable/runtime-module closure. The managed release artifact binds the active installation/build/bootstrap, full Host package digest, source commit, captured source digest and build-input digest. An arbitrary local repository HEAD or build label is not that proof.

Use existing source/build provenance where it actually supplies this binding; the portable P4 path currently supplies no universal such manifest. P5.1 must add the small trusted startup/capture binding, outside candidate control. If provenance is unavailable, source differs from the bound baseline, or the runtime is modified after enrollment, refuse Self-Repair; ordinary P2/P4 remain usable. Never load the legacy `hostAuthority` native build path into a P4 Run just to obtain a source label. This requirement prevents a Repair claiming to repair a different Deszo revision.

### 7.3 Normative identity formulas

`H(x)` means SHA-256 over existing `canonicalBytes(x)` for JSON, or exact bytes for file content; include the named schema/version domains. Sort file arrays by existing locale-independent `compareText(path)`; paths retain case. Reject duplicate/case-alias names, never silently collapse them.

```text
fileEntry = {path, type:"regular", byteSize, sha256, executable:boolean}
sourceDigest = H({kind:"P5SourceTree", version:1, entries:[sorted fileEntry]})
baselineId = H({kind:"P5Baseline", version:1, repositoryIdentity,
                gitObjectFormat, baseCommit, baseTree, pathPolicyDigest,
                effectiveSourceDigest:sourceDigest, dirtyPolicy:"clean-committed"})
candidateId = H({kind:"P5Candidate", version:1, baselineId,
                 incidentId, parentRunId, repairRunId, linkId,
                 developerAttemptId, candidateOrdinal:1, workspaceAllocationId,
                 candidateSourceDigest, selfRepairProfileDigest,
                 verificationPolicyDigest, verificationInputsDigest})
```

Source identity covers **all included source**, not merely changed files or Git status. Executable bits are source metadata: initial default scope forbids their changes; Windows capture uses committed mode plus an explicitly approved metadata change, never a guessed `stat` execute bit. Native volume/file IDs detect directory replacement and are allocation evidence, not portable source content. Timestamps and absolute materialization paths do not enter `sourceDigest`.

The static baseline manifest contains repository/commit/tree, the canonical source worktree root, the immutable selector object and its digest, effective-source identity, content refs, trusted release provenance and capture time, never future Run/incident/publication bindings. Candidate and per-admission binding manifests add actual Parent/Repair publications, P3 incident/outcome ID+revision, source binding, captured policy/installed-enrollment refs and journal cursor. A different base, changed file bytes/path/mode, effective source closure or policy cannot masquerade as the same candidate. Identical bytes in a different incident may share content objects but not candidate identity. Inherited Git SHA-1 commit identity never substitutes for the P5 SHA-256 content inventory.

## 8. P5-02/P5-03 — Workspace, mutation and scope authorization

### 8.1 Workspace lifecycle

P4 profiles currently require an already registered existing `repairWorkspaceId`. Preserve that contract. Before Parent publication/enrollment, create/register an **empty, dedicated, single-use P5 slot**, outside Parent workspace, original Deszo checkout, active Engine/Host installation, profile/store and credential roots. This administrative preparation is separate from executing Repair. The Parent profile pins that exact workspace ID, canonical root and native allocation identity. No model chooses a directory. Each slot belongs to one P2 link for its lifetime; obtaining another slot requires new explicit enrollment/publication, not a model allocation command.

Layout within the pinned Repair workspace:

```text
<slot>/source/                 Developer candidate source, included in seal
<slot>/.p5/control/            Engine materialization bookkeeping (not authority)
<slot>/.p5/verify/source/       Fresh reconstruction of the sealed source
<slot>/.p5/verify/scratch/      Test-only generated files and tool outputs
```

Authoritative allocation metadata is in store artifacts/journal; a marker inside the slot is only a consistency check. Run CWD remains the P2 workspace root; Developer instructions name `source/`. Pin all subroots and validate non-overlap/identity before use. Custody's hold on the workspace covers every subdirectory and both Developer and verifier stages. The verified source root is distinct from Developer source. Reject arbitrary extra source roots, network shares, reparse ancestors and overlapping aliases. P5 Engine writes are restricted to its exact enrolled slot and existing artifact store.

After P2 authorization but before Developer dispatch, persist preparation intent (`linkId`, allocationId, expected baseline, workspace IDs) under the Store transaction. Materialize only captured baseline objects into new `source/`, using exclusive creates. Record prepared state only after independently comparing it to the baseline. Recovery may fill a missing file only while the durable state is `preparing`, no Developer launch/admission exists, every present file matches the baseline and topology/ownership still match. Any conflicting file or ambiguous launch quarantines the slot; do not wipe/recreate it. Once Developer admission exists, preparation is never repeated.

Engine workspace admission and rebind/release paths must consult the journal-derived P5 slot reservation, including idle intervals between Custody holds. A slot with a P5 allocation or uncertain preparation cannot be assigned to an ordinary Run even after the Repair becomes terminal. Existing locks/holds alone do not reserve these intervals. This is an Engine guard over existing workspace records, not another lock service or scheduler.

### 8.2 Path and filesystem contract

Initial supported source names are portable ASCII relative paths with `/` separators. Reject absolute/drive/UNC paths, `.`/`..`/empty components, backslashes, NUL/control characters, `:`, Windows device names (including extension aliases), trailing dots/spaces, reserved `.git` and `.p5` components, case-insensitive collisions, directory/file collisions and case-only renames. A rename is delete+add. Unicode/short-name aliases, junctions, symlinks, any reparse tag, hardlinked files (`linkCount != 1`), submodules and special files are unsupported. Where the platform cannot establish these facts, refuse the topology rather than infer them from a pathname.

On Windows record volume/file identity and reparse/link facts with a bounded native identity reader (existing native primitives may be reused); `lstat().isSymbolicLink()` alone is insufficient for all reparse types. Verify root and ancestors, open regular files without following redirection where available, compare file identity/length before and after reading, enumerate twice and reject drift. Store the bytes actually read, then independently re-enumerate/rehash. After Developer tree termination, no new writer is dispatched before capture. At later boundaries recheck both source trees against the sealed manifest.

These checks detect unsupported or changed topology and ordinary concurrent writes. They do not make a same-user multi-file snapshot atomic against a hostile swap-and-restore adversary. The supported topology requires no outside writer or ancestor retargeting during capture/verification/acceptance. An observed violation is a deterministic blocker. If that operational precondition cannot be established for an enrollment, do not admit it. P5 performs **no privileged rename/promotion into the original source and no automatic recursive deletion**, so the known cleanup race is not reused as a publication primitive.

### 8.3 Scope policy and authorization

`ProtectedSelfRepairProfile/1` is an immutable artifact, with strict required fields:

| Field group | Required captured values |
|---|---|
| Enrollment/source | Enrollment ID, repository/baseline and trusted running-source release refs, eligible P3 source/category/canonical-code set and exact failed node; actual installed manifest/source-binding refs are captured separately at admission |
| Workflow | Exact Repair workflow/publication/snapshot, Developer/result node, verification Gate and designated Repair Judge; enclosing Parent publication/policy is bound by installed enrollment and captured authorization, not recursively inside this artifact |
| Workspace | Registered slot/root/allocation identity, `clean-committed`, single-use/stable-topology profile |
| Scope | Included source closure, default denied/excluded paths, allowed add/modify/delete paths, metadata permissions, sensitive-category approvals and size/count bounds |
| Verification | Immutable verification plan ref/digest, installed harness closure/tool identities, required stage/check IDs and coverage floor |
| Result | Required source/baseline/change/receipt artifacts; P6 handoff schema/version; no source merge or activation capability |
| Budgets | One candidate per link; Developer attempt/wall time, maximum source bytes/files, verification aggregate/per-check limits, captured retry allowance and P4 Judge/expansion limits |
| Continuation | Existing `acceptanceMode='judge_post_execution'`, existing `failedNodeRetry`, never a result-selected retry flag |

P5 capture verifies equality between Parent profile, exact Repair Gate policy and installed enrollment manifest; conflicting copies fail closed. Pin all referenced bytes into normal artifacts before admission. No publication marker or filename alone confers enrollment. Direct starts/node/branch previews of an enrolled Repair cannot obtain P5 privileges; workflow-originated execution requires the exact current Parent Judge `request_repair` and P2 link. Existing Owner linked-Repair routes must refuse bypassing the P5 contract for a P5-enrolled publication. They retain legacy behavior for non-P5 workflows.

The verification policy pins permitted incident-input selectors/reproducer templates before publication. P2 request capture resolves those selectors only against the current bounded P3 evidence and stores an immutable `ProtectedSelfRepairVerificationInputs/1` artifact containing actual incident/outcome revision and input refs before Developer launch. No model-selected command or new check is introduced. Candidate identity, authorization, receipt and handoff bind that input artifact/digest in addition to the static verification-policy digest; the policy itself does not contain a future incident ID. A missing required incident input refuses admission. Root/CWD placeholders resolve only to enrolled allocation identities and are recorded in the exact command manifest.

No scope expansion is accepted from Developer output, Judge output or an Owner answer to a pending semantic question. Stronger scope means a newly enrolled/captured profile before a new Repair admission; the original remains immutable. Eligible source failures are selected from settled P3 evidence; unknown/unresolved execution is a P1 hold, never permission to repair by guessing transcripts.

| Source category | Initial policy and mandatory extra verification |
|---|---|
| Ordinary application source | Explicit component allowlist; reproducer, targeted regression, schema/type checks where relevant and fixed minimum safety checks. |
| Engine state machine / P2 / P4 | Explicit sensitive scope grant; protected state/authority/replay/Stop suites and broader Node regression gate. Core repairs are allowed with these prerequisites. |
| Host/Custody/process ownership | Explicit scope; trusted Host/descendant/Engine-replacement/Windows process tests and affected Rust suite. No replacement of the running Host. |
| Authorization, Owner Token, security configuration | Explicit security scope; protected credential-route, foreign/stale authority and secret-hygiene checks plus broader regression. |
| Migrations | Explicit schema scope; old/new fixture upgrade, atomicity/rollback and legacy compatibility tests. Production store is never migrated by a test. |
| Tests / test infrastructure / workflow and verification definitions | Explicit sensitive scope; **baseline/installed harness remains authoritative**; candidate tests are supplemental, and policy/coverage cannot be lowered. A proposed new policy is source for a future release only. |
| Dependency locks / build and deployment scripts | Denied by default; explicit scope requires captured dependency/tool inputs, lifecycle-script review and broad checks. If safe closure is unavailable, block. No production deployment command. |
| Installed binaries, Host/control state, credentials, original workspace, object store | Never a candidate mutation target. Engine/API protection for normal operations; arbitrary same-user writes remain AR01, not a claimed OS denial. |

## 9. P5-04 — Candidate manifest and sealing

Developer completion is insufficient. Wait for authoritative `processTreeEnded=true`, complete captured Developer output and no overlapping unresolved hold. Independently traverse `source/`; do not use the Developer's file list, patch text, `git diff` alone, or historical test artifacts as the actual inventory. Compare the complete inventory with the baseline, validate scope/categories/metadata, and publish each file into the existing store. Any bound violation yields no partial candidate success.

The Engine issues strict `ProtectedSelfRepairCandidate/1`:

```text
{ kind, schemaVersion:1, candidateId, baselineRef, baselineId,
  baseCommit, baseSourceDigest, candidateSourceDigest,
  sourceManifest:ArtifactRef, changeManifest:ArtifactRef,
  repositoryIdentity, sourceBinding:ArtifactRef,
  workspace:{workspaceId, allocationId, canonicalRoot, sourceRoot, nativeIdentity},
  parentRunId, repairRunId, linkId, incidentId, outcomeId, outcomeRevision,
  parentPublication, repairPublication, developerNodeId, developerAttemptId,
  selfRepairProfile:ArtifactRef, verificationPolicy:ArtifactRef,
  verificationInputs:ArtifactRef,
  developerTerminalEvidence:ArtifactRef, capturedAt, journalCursor }
```

`sourceManifest` lists sorted complete `fileEntry` values plus their content `ArtifactRef`s. Content-artifact IDs do not enter the portable source digest; their bytes/digests do. `changeManifest` binds baseline/candidate digests, candidate/allocation/Run/incident IDs, profile/verification digests, and sorted changes `{path, operation:add|modify|delete, before:null|fileEntry, after:null|fileEntry, beforeArtifact?, afterArtifact?}`. No-change candidates are rejected as `p5_no_source_change`; no review loop is launched for them. Added/deleted file and executable metadata are explicit; binary files use exact bytes.

Seal is the transaction committing the candidate/artifact refs and `self_repair.candidate_captured` event, after every referenced object is readable and digest-verified. The sealed object set is the candidate; a mutable workspace is only a materialization. Candidate objects never change in place. P5's maximum is one captured candidate identity per link. A later edit is `candidate_changed_after_capture`, invalidates eligibility, and cannot silently supersede the seal or reuse its verification. Another candidate requires a new explicit Repair admission under meaningful new evidence, subject to existing P4 incident uniqueness.

Logical sealing does not change OS permissions or stop external same-user writers. Rehash live `source/` before verification, after verification, before Judge admission and after Judge termination before applying its decision. Verify `.p5/verify/source/` before and after all checks as well. A missing/replaced materialization or inconsistent object is a blocker, not a reason to trust the Developer text instead.

## 10. P5-05 — Independent verification

### 10.1 Selected boundary and plan

Choose deterministic Engine/Host checks **plus the existing independent Repair Judge**, without a separate verification LLM. An ordinary verification Agent alone could omit checks, edit criteria or fabricate success. Engine-checked Agent prose would still not prove which commands ran. The deterministic Gate provides those observations; Judge provides bounded semantic review.

Capture `ProtectedSelfRepairVerificationPolicy/1` before Developer launch, including:

| Item | Normative requirement |
|---|---|
| Plan identity | Policy/coverage schema version, required/optional ordered check IDs and stage IDs, exact expected assertions/test selectors and expected verdict rules |
| Defect evidence | Fixed incident-input selectors and immutable reproducer/templates; admission captures actual P3 incident/input refs separately. Expected baseline failure and candidate success, or a preapproved explicit alternative when reproduction is unavailable |
| Source requirements | Scope/forbidden-file/no-op/metadata checks, full candidate object verification, source closure digests, required sensitive-category floor |
| Commands | Absolute tool identities, exact argv arrays, shell disabled, CWD mapping to verified source/scratch, input refs and sanitized environment values/allowlist |
| Harness | Installed trusted launcher/control-module closure, baseline protected test inputs and fixed review prompt; none selected from candidate changes |
| Subject binding | Per-check adapter/mode, candidate-relative subject entrypoints, candidate module/executable closure, trusted-driver identity and any derived execution-tree/overlay identity; CWD alone is never the binding |
| Dependencies | Captured lock/immutable tool/dependency input identities and approved offline cache; no unpinned download, candidate lifecycle install hook or user config auto-discovery |
| Completion | Per-check timeout/expected exits, output limits, aggregate deadline, minimum required assertions, retry/flake policy, capture completeness |

The policy is data, not an arbitrary shell/plugin. Unknown fields, command templates with unbound interpolation, missing mandatory checks, inaccessible tools or a test that discovers uncaptured local inputs are rejected before execution. The Gate cannot downgrade checks after seeing a failure. Scope-based selection is deterministic from the captured category-to-check map; an unknown sensitive path or new category blocks instead of falling back to the ordinary tier.

### 10.2 Execution and harness integrity

1. Verify the sealed source objects and the live Developer source still match the candidate. Reconstruct a fresh `verify/source/` exclusively from those verified objects. It has no `.git`, user credentials, existing test roots or inherited node modules.
2. Stage the **trusted harness/control closure outside the candidate** from the installed enrollment; verify its files/tools before use. The initial implementation may use an allowlisted Node executable plus a pinned installed `runtime/verification/p5Verifier.mjs` closure. The Rust Host checks the executable, while Engine separately binds script/closure/argv/input digests; Host executable allowlisting alone does not attest scripts or descendants. Missing installation identity refuses launch.
3. Start one verifier launcher under the Gate Attempt using the existing `custody.reserve` → durable binding/hold → `custody.launch` protocol. The launcher runs ordered checks and all descendants stay in the existing Host containment. It is a bounded command, not another supervisor service. Engine's `processes` record makes root Stop stop this Gate the same way as other owned work.
4. Keep trusted orchestration separate from candidate execution. Never import candidate modules, build plugins or tests into the running Engine or trusted receipt writer. The launcher pipes candidate output as labeled untrusted data; it never inherits the trusted result stream into a candidate child or parses candidate stdout as its own completion record. Protected assertion drivers remain outside the editable source; candidate code runs as child subjects. Candidate test suites may run as supplemental checks, but their assertions are not the only mandatory evidence.
5. Capture a bounded per-check start/end observation, exact command/input IDs, output refs and assertion completion. Source is immutable input by policy; write caches/output into scratch. A tool needing writes to source is unsupported until the plan defines a separate content-verified materialization and proves it cannot change the subject under test.
6. On completion require Host `exited`, expected launcher exit status, `processTreeEnded=true`, `spoolComplete=true`, no output/capture gap, every required observation and assertion, no timeout/cancel, unchanged harness/tool identities and unchanged source inventories. Only then may Engine issue a passing receipt and succeed the Gate.

Candidate code and its dependencies can execute arbitrary code during tests. Separate processes, output framing and digest checks provide control/observation separation in the supported cooperative profile; they are **not** an OS hostile-code barrier. A malicious process able to edit the installed harness, inject into it, steal a bearer or corrupt the store defeats that trust assumption. Such an adversarial enrollment is unsupported without separately enforced isolation. Before/after hashes also do not prove absence of transient edit-and-restore attacks.

### 10.2.1 Proving that protected checks exercise the candidate

Every required check captures a subject adapter and emits an Engine-verifiable subject-resolution manifest. It identifies exact candidate entry modules/executables, their source/closure digests, required dependency inputs, driver identity and which check/assertion uses that subject. A launcher running from `verify/source/` is insufficient: existing repository tests such as `runtime/tests/helpers.mjs` import `../runner.mjs` and `../core/*` relative to their own file, so running installed baseline tests with a different CWD could silently test the installed baseline.

Use one of two explicit captured check bindings. For protected out-of-process probes, the installed driver launches the candidate subject at a resolved absolute path under the verified materialization, with a pinned adapter/entrypoint and closure manifest. For reuse of existing relative-import suites, construct a **derived execution tree** from the exact candidate and replace only a predeclared list of test/fixture/driver files with protected baseline bytes. Capture `executionTreeDigest = H({candidateSourceDigest, overlayManifestDigest, completeExecutionInventory})`; every non-overlay path must equal the candidate, and each overlay entry binds the candidate before digest and protected replacement digest. Run tests from that tree so relative imports resolve to candidate production modules. Record the actual subject entrypoint/process and resolved module/fixture map. Do not call the derived tree's digest the candidate digest.

The overlay may not replace production modules, Host/Engine/authorization code or a changed build/config source merely to make tests pass. If a changed test/driver file is overlaid for the mandatory safety suite, add a captured independent non-overlay check of that candidate file's behavior/syntax/contracts; otherwise that scope is unsupported. Candidate tests can also run separately as supplemental evidence. Required checks that cannot establish candidate subject binding fail admission or produce an incomplete receipt, never verification success. Verify derived tree inventories before/after execution with the same regular-file/topology rules, and bind their identities into the receipt. A mandatory negative fixture must have baseline B pass while broken candidate C fails, even when candidate-edited tests claim success. This proves actual subject selection rather than only trusted harness selection.

### 10.3 Targeted versus broad verification

Every candidate requires deterministic identity/scope/artifact checks, captured reproducer evidence, targeted affected regression and the installed minimum safety checks. A small ordinary-source fix may stop there if the pre-captured coverage rule explicitly covers all changed paths.

Broader checks are mandatory for state-machine/authorization/migration/Host changes, test/harness/build/dependency changes, cross-component changes above the captured path/count threshold, or any policy marked broad. Engine selects the **union** of all applicable floors. Candidate modifications to `package.json`, test runners, assertion lists or workflow JSON do not change that union. Use installed/baseline test definitions and exact selectors; candidate-added tests supply additional evidence. Full final Node/Rust/docs/build regression is an implementation-closure gate for P5 itself and may be a captured broad candidate gate; it is not imposed on every experiment. P6 later chooses its own build gates.

### 10.4 Completion, flakiness and failure

Default: one verification invocation, no automatic retries. Required checks may not be skipped/reused from a previous candidate, plan or Gate Attempt; `skipped`/`reused` Attempt states are insufficient for P5 acceptance even where generic P4 tolerates them. Optional failures are reported and may inform Judge; they cannot replace a required check. An optional check's classification is fixed before execution.

Timeout, canceled check, missing assertion, output limit, missing result, incomplete spool, infrastructure error or an unrun mandatory stage means `incomplete` or `failed`, never `passed`. Host/tree uncertainty is `uncertain` and retains the hold. A deterministic failed mandatory assertion is `failed`. A declared flaky check has a finite pre-captured schedule and an explicit aggregate rule (initial policy: every scheduled mandatory observation must pass). A failure cannot be erased by running until green. An explicitly captured infrastructure retry may create a new Gate Attempt only after terminal/tree evidence, unchanged sealed candidate and safe scratch-only effects; retain all prior observations. No retry of an uncertain invocation. Initial profiles set that allowance to zero.

A non-passing receipt fails the Gate and blocks the P2 result. Current P4 may open bounded failure attention for wait/semantic input; it must not open `repair_approval` or accept-repair authority for failed verification. Deterministic rejection does not require a model turn. Judge `reject_repair` remains available for a candidate that passed required checks but is semantically unacceptable. No new P4 decision type is needed.

## 11. P5-06 — Receipt and trustworthy provenance

Engine, not Developer or a file in its workspace, issues `ProtectedSelfRepairVerificationReceipt/1`. It is a normal immutable artifact with a journal reference and Gate Attempt output. A supplied `report.json` or a file that copies this schema is untrusted input and cannot create the Engine event/Attempt effect.

```text
{ kind, schemaVersion:1, receiptId, status:passed|failed|incomplete|uncertain,
  candidateId, candidateSourceDigest, baselineId,
  candidateManifest:ArtifactRef, changeManifest:ArtifactRef,
  selfRepairProfile:ArtifactRef, verificationPolicy:ArtifactRef,
  verificationInputs:ArtifactRef,
  repairRunId, linkId, incidentId, verificationNodeId, gateAttemptId,
  execution:{custodyId, hostIdentity, lifecycleGeneration, engineEpoch,
             invocationDigest, commandManifest:ArtifactRef,
             executableIdentity, harnessClosureDigest,
             testInputManifest:ArtifactRef, environmentDigest},
  checks:[{checkId, stageId, required, commandDigest, toolIdentities,
           inputDigest, subjectResolution:ArtifactRef, executionTreeDigest,
           overlayManifest:ArtifactRef|null, startedAt, endedAt, status, exitCode,
           expectedAssertions, completedAssertions, stdout:ArtifactRef,
           stderr:ArtifactRef, observations:ArtifactRef}],
  requiredCheckSetDigest, completedCheckSetDigest, sourceBeforeDigest,
  sourceAfterDigest, liveCandidateDigest, harnessAfterDigest,
  terminalEvidence:ArtifactRef, captureStatus,
  startedAt, completedAt, observationJournalCursor, issuedJournalCursor }
```

`receiptId = H({kind:'P5Verification', version:1, candidateId, verificationPolicyDigest, gateAttemptId, custodyId, observationSetDigest})`. The result identity is not a filename, model UUID or last stdout line. Engine validates every required observation and referenced object before committing the receipt, Gate outputs, Gate success/failure and receipt event in one Store transaction. A crash after object writes but before that transaction leaves harmless unreferenced objects, not verification success. Journal cursor fields refer to committed observation events; if the exact issuance sequence cannot be known in advance, use the assigned event sequence returned by `appendEvents` as the authoritative issuance cursor and omit that redundant self-reference from the receipt body.

Canonical P5 record digests use the repository's canonical JSON encoding and SHA-256. For the v1 implementation, each policy check carries `commandDigest = H({kind:'P5VerificationCommand', version:1, checkId, stageId, required, executable, executableSha256, argv, cwd, inputRefs, environment, subjectEntryPoints, expectedAssertions, expectedExitCodes, timeoutSeconds, maxOutputBytes, subjectBinding, overlayPaths})`. The receipt's `observationSetDigest` is the hash of the complete check-observation records sorted by `checkId` using the runtime's ordinal text ordering. `requiredCheckSetDigest` and `completedCheckSetDigest` hash their respective sorted check-ID arrays. These digests bind the captured plan and observations; they do not replace Engine validation of referenced objects or Host/Custody provenance.

Each `ProtectedSelfRepairSubjectResolution/1` binds the candidate/source/baseline, check ID, exact policy/input refs, declared entrypoints, driver identity, resolved source files and assertion-to-source bindings. `sourceClosureDigest = H(resolvedFiles sorted by path)`, and every resolved file must match the candidate source manifest. `inputDigest = H({kind:'P5CheckInputSet', version:1, candidateId, candidateSourceDigest, baselineId, checkId, staticInputRefs:sorted policy refs, incidentInputs:sorted captured input records})`. The Engine-issued test-input manifest must carry those exact per-check input and subject refs. `executionTreeDigest = H({kind:'P5VerificationExecutionTree', version:1, candidateId, candidateSourceDigest, baselineId, checkId, subjectResolution:ArtifactRef, inputDigest, overlayManifest:ArtifactRef|null})`. Each referenced check-observation artifact repeats the receipt row's candidate, check, command/input, subject/tree, status/assertion, output-ref and capture facts exactly. These identities bind records together; actual materialization, observed process execution and Host provenance still require Engine/Host enforcement.

The Host currently hashes argv/CWD/stdin and **environment names**, not every environment value. Therefore P5 command manifest separately captures sanitized non-secret effective environment values/digest, runtime/version, working-root/input identities, tool and script closure digests. Do not overstate the Host's `invocationDigest`. Tool versions are descriptive; executable/closure digests carry identity. Dependent compilers/tools must be pinned separately: the Host's launcher hash is not a proof of all descendants' binaries.

Truth labels stay distinct: `engine_trusted` for selected policy/derived source facts/receipt verdict, `host_terminal_evidence` for process observations, `workflow_output_untrusted` for Developer narrative, `provider_untrusted` for model reasoning, and `owner_input` for answers. Trusted means issued by the specified control boundary under §15 assumptions, not that arbitrary test stdout is true.

**Acceptance invariant:** receipt candidate/base/policy/Run/link/Attempt identities must exactly equal the sealed subject and current authorization, every required check must have a complete passing observation, and all objects must verify. Receipt A cannot authorize candidate B, even if filenames, paths, Developer text or test names happen to match.

## 12. P5-07 — P4 Judge and P2 integration

### 12.1 Admission and atomic application

Keep P4 CP-01–CP-05 ordering. Once Developer is settled, candidate is sealed, verification Gate succeeds and its Engine receipt passes validation, `workflowJudgeContext` may create the existing `repair_approval` context. Include a bounded P5 summary and issued detail refs in `JudgeEvidencePackage`: baseline/candidate digests, changed-file/category counts, scope verdict, mandatory/optional check totals, receipt status and exact Gate/Custody IDs. Large source manifests stay behind digest-verified bounded reads. Preserve P4's 16 KiB initial evidence bound, issued-reference restrictions and captured expansion/attempt limits; insufficient bounded summary fails admission rather than omitting an acceptance prerequisite.

**Proposed P5-only detail extension:** current P4 Repair approval does not permit `request_evidence`, and its catalogue ignores artifacts over 64 KiB. Merely attaching a large manifest ref would not let the Repair Judge inspect it. For enrolled P5 `repair_approval` only, permit the existing `request_evidence` action, without adding a decision type or changing legacy Repair permissions. Engine builds an immutable review dossier of the actual changed-file manifest, complete required textual diffs/context and verification/subject-binding summaries. Chunk it into **at most four Engine-issued artifacts, each at most 64 KiB**, with the complete encoded expansion artifact at most **256 KiB**. The 16 KiB initial package contains their refs, candidate/receipt identities and `requiredReviewSetDigest`. Raw source text retains its untrusted-data label even in an Engine-generated dossier.

Initial P5 profiles require `maxEvidenceExpansionsPerAttention=1` and enough captured Repair Judge budget for the initial and follow-up Attempts. The request must name the exact issued required set; its existing P4 expansion event and follow-up input bind those bytes/candidate/cursor. Acceptance is unavailable until that set is actually delivered to the designated follow-up Judge input. A model assertion that it read a file is insufficient, and delivery is not proof of model comprehension. Wait/questions do not reset expansion or attempt budgets. If required review content cannot fit the four-artifact/encoded bound, or the budget is exhausted, record a deterministic review-evidence blocker and refuse approval; do not silently truncate the required diff or create a review loop. Binary changes require explicitly captured machine-verifiable review observations/metadata; otherwise that scope is unsupported. Larger repairs need a separate design rather than bypassing current P4 bounds.

Current P4 answer application creates fresh evidence with no expansion and a fresh attention with expansion count zero. The **P5-only question follow-up** must instead preserve the per-subject `(candidateId,receiptId,requiredReviewSetDigest)` delivery/allowance lineage in journal-backed artifacts. If its required dossier was already delivered, carry the same verified chunk refs and contents into the answer-follow-up Judge input without granting another expansion; re-envelope them with the new attention key and original delivery-event/Attempt refs, since P4 validates that key. The total encoded input expansion remains within 256 KiB. If not yet delivered, the subject retains only its original unused allowance. New source/receipt identity invalidates the old subject rather than resetting a repair loop. Carrying is a pure bounded evidence operation recorded with answer/next-Attempt settlement, not new verification or approval. A missing/mismatched carry lineage blocks acceptance. Existing non-P5 P4 answer behavior is unchanged; an Owner answer alone still resumes only the originating Repair Judge.

Extend the existing evaluation cursor with `{candidateId, candidateManifestSha256, verificationReceiptSha256, verificationPolicySha256, sourceIntegrityRevision, retentionRevision}`. Only meaningful changes revise it. The Engine checks integrity before scheduling Judge and again after Judge tree termination. Judge runs in the same P2 workspace as today and is policy-only read-only; a candidate change by that process is detected and invalidates acceptance. The source objects remain the sealed subject. No Judge source execution or new write stage is scheduled.

When the current designated Repair Judge proposes `accept_repair`, run a P5 eligibility predicate **inside `applyWorkflowJudgeRepairApprovalInTransaction`, before its existing link CAS**. Reuse the immutable evidence/integrity/Stop checks at adaptive outcome reconciliation, Parent-resume eligibility and handoff publication, with the distinct phase preconditions below; do not literally reuse the approval-phase open/pending state after acceptance:

1. Exact current Parent/Repair Runs, publications, P2 authorization, incident, link, enrolled profile, Developer and Gate Attempts, designated Judge Attempt, attention and causal cursor match.
2. Current phase-specific Run/link preconditions pass, no Parent Stop/P5 invalidation exists, and no relevant P3/Host effect uncertainty or overlapping hold remains. Approval specifically requires the current eligible suspended Parent and open/pending adaptive link.
3. Candidate/change/source objects verify; source scope/metadata/coverage floor pass; candidate has not drifted since seal; verification materialization and harness identities still match.
4. Engine-issued receipt is for that exact candidate/profile/plan/Gate invocation; required checks/stages/assertions completed successfully with full capture, expected exit and ended process tree. No skipped/reused verification success is substituted.
5. The exact bounded required review set was delivered in this attention's designated Judge input and still matches candidate/receipt/cursor. Existing P4 authority validation passes. Existing P2 `failed_node_retry` is unchanged.

| Phase | Required durable state after common evidence/integrity/Stop checks |
|---|---|
| Apply Judge acceptance | Link `open`, `decision_status=pending`, adaptive mode, Parent `waiting_for_user`/eligible suspension as in P4; exact live Judge/cursor. Existing P4's narrower CAS remains authoritative. |
| Record successful Repair outcome | Link `open`, `decision_status=accepted`, matching extended approval/result/receipt; Repair is settling `succeeded`; no later Stop/invalidation. Existing P2 CAS produces `repair_accepted`, `repair_outcome=succeeded`. |
| Resume Parent | Link `repair_accepted`, accepted decision and succeeded Repair outcome; exact existing P2 Parent state/checkpoint/no-work/`failed_node_retry`/P3 gates. `never` blocks retry exactly as today. |
| Publish/consume handoff | Extended approval exists and Repair is `succeeded`, decision accepted and outcome succeeded; link may be `repair_accepted`, `resumed`, or `blocked` **only** when the durable `continuation.parent_resumption_blocked` event proves `retry_not_authorized` for captured `never`. A generic blocked state, integrity/uncertainty block, rejection or Stop is insufficient. Parent success after a valid resume does not erase candidate acceptance; later Stop/cancel/invalidation still denies consumption. |

Admission/live-Judge checks are historical verified bindings after the decision commits, not a requirement that a terminated Judge remain live forever. Later phases validate its recorded decision/attention/Attempt and phase-appropriate current cursor/integrity revisions. A bounded no-retry Parent block is compatible with an accepted source handoff; it is not permission to resume that Parent.

Filesystem reads/hashing cannot be made atomic with SQLite by a transaction. Perform bounded integrity capture before acquiring the write transaction, persist its revision, and recheck allocation/no-writer/receipt revision inside it; hold Engine workspace reservation through commit. In the supported stable-topology/cooperative profile, no authorized writer can enter that interval. If an outside writer or handle/topology uncertainty exists, block. Do not claim a SQL lock protects against hostile filesystem writes. No acceptance writes or renames live source; its subject is the verified immutable object graph.

Add a strict optional `selfRepair` extension to existing `AdaptiveRepairJudgeDecision`: candidate/baseline IDs and refs, change/source manifest refs, verification receipt/plan refs, enrollment/source-binding refs, integrity revision and scope result. Existing `resultSha256` continues to identify the Developer **text**; it is not renamed or reinterpreted as `candidateSourceDigest`. Record P5 approval binding, P4 decision, `repair.approval_recorded`, and existing P2 link CAS in the same transaction as Judge settlement. P2 link `candidate_digest` from the legacy lifecycle path is not repurposed as an activation selector.

On `reject_repair`, use the existing P4/P2 rejection path and retain candidate/evidence. On failure of a deterministic acceptance predicate, apply no approval effect, durably supersede/reject the stale proposal and hold/fail the Repair as appropriate. Judge cannot waive a failed check, approve a different workspace, amend scope, mint a receipt, change retry policy or request P6 activation through this contract.

### 12.2 Stop and Parent semantics

Existing Parent Stop wins. The Stop transaction must invalidate P5 pending acceptance/handoff eligibility along with P4 attention/questions and existing link state; the existing P2 after-commit stop/recovery callbacks stop linked processes. If Stop commits before acceptance, later Judge output cannot accept. If acceptance commits first, its historical receipt remains true, but a later Stop cancels pending continuation and marks any unconsumed handoff ineligible. A later caller must read current status, not rely solely on an old acceptance artifact. No rollback of arbitrary test side effects is claimed.

The existing terminal-Run early return in `Engine.stopRun` and the `afterLogicalParentStop` link-state filter do not currently cover all accepted P5 handoffs. Add a **P5-only idempotent eligibility invalidation inside Stop's Store transaction before the terminal-Run early return**, selecting the Parent's enrolled P5 projection independently of that P2 callback filter. Include `blocked` after captured `never` and `resumed`/terminal Parent cases. An already terminal Parent keeps its Run/P2 historical state; the new event only revokes pending/unconsumed P5 eligibility and changes the P5 status revision. Repeated Stop appends no duplicate invalidation. Active linked work still uses existing P2/Custody Stop delivery. No new stop supervisor or general terminal-Run reopening is introduced.

P2 may continue the same Parent Run only under its existing checkpoint, no-in-flight-work, safe effect and retry predicates. `failed_node_retry='never'` permits retaining an accepted candidate but blocks retry. `explicit_safe` still needs current P3 proof of no effects and Host termination/full capture as implemented. A retry, if permitted, executes the **currently running Engine**; it does not install the repaired code and may fail again. P5 profiles for source fixes that require a new runtime must capture `never`. P6 activation/continuation is a later independently authorized lifecycle action. Do not reclassify source acceptance as “the original incident is fixed in the running app.”

## 13. Durable representation, versioning and reconciliation

### 13.1 Minimum additions: artifacts/events, no new SQL

Use `run_links` authorization/checkpoint/approval refs, ordinary `runs`, `attempts`, `attempt_custody`, `custody_workspace_holds`, `resource_locks`, immutable artifacts and `journal_events`. No candidate DB or verification queue is needed. P5 artifacts are strict versioned JSON; source file bytes use current media/content storage. JSON references use the existing `ArtifactRef` shape so artifact-reference indexing can follow them. Handoff/enrollment refs are journal-reachable; any future GC must treat those events as roots. Current P5 never requests their deletion.

Proposed v2 journal events are `self_repair.source_bound`, `preparation_intent`, `workspace_prepared`, `candidate_captured`, `verification_started`, `verification_recorded`, `candidate_invalidated`, `review_delivery_carried`, `handoff_recorded`, `retention_changed`, and `cleanup_deferred` (each prefixed `self_repair.`). Each wraps `{record:ArtifactRef}` using P4's existing event pattern. This needs schema/runtime projection additions, **not** a new journal envelope version or migration. P3 failures and existing P4/P2 events remain authoritative for their own domains.

An event-derived per-Repair projection has `{linkId, allocationId, stage, stageRevision, artifactRefs, retention, stopInvalidated}`. Query events by existing Run + event type/sequence, verify envelopes/artifacts, fold within the finite captured event budget. Initialization caches are disposable; the journal is authority. Under `BEGIN IMMEDIATE`, read current stage and append a transition only if `(linkId, stage, revision)` still equals the expected predecessor. The runner lock, Host epoch and these CAS preconditions prevent two lawful Engines committing the same next stage. Repeated reconciliation cannot append a second logical capture, approval or handoff. `run_links.repair_run_id`/incident uniqueness, existing approval CAS and command receipts retain their existing SQL enforcement.

Artifact objects can be written before the state transaction, but no authority exists until an event/record references them. Creation intents precede filesystem side effects. Native workspace allocation identities and partial materialization are recovered through that same event projection; unknown orphan paths are never adopted or removed by directory enumeration. No exactly-once arbitrary filesystem or test effect is promised.

New SQL is **not required** for a unique stage within one linked Run because Store writers are serialized and the event append/predecessor check share a write transaction. This avoids extending fixed `pipeline_records.kind` or `run_links` state enums for a second candidate state machine. If later scale requires a projection/index, demonstrate a bounded-query or cross-Run uniqueness invariant that this design cannot satisfy, and propose it separately; do not silently introduce M23 here.

### 13.2 Startup order and recovery keys

Extend existing `Engine.initialize/recover/reconcileContinuations` with P5 eligibility/projection calls. There is no second timer or recovery loop. Host attach and P1 custody/hold recovery remain first. Before queued dispatch or P2 continuation can act on a P5 Run, reconstruct its P5 projection, validate enrollment/source/object/slot bindings, restore its workspace reservation and enforce Stop. Attach in-flight Developer, verifier Gate or Judge by its original Attempt/Custody identity. Then complete any pure capture/receipt/attention/handoff step whose durable preconditions hold. Post-commit pump/Host delivery remains outside transactions, as in P4 CP-03.

```text
authorized -> preparing -> prepared -> developing -> captured
  -> verifying -> verified -> judge_pending -> accepted -> retained_for_p6
                 |             |                 |
                 +-> rejected <-+                 +-> invalidated/stopped
any active stage -> held_uncertain (same owned invocation; no relaunch)
terminal rejected/invalidated/stopped -> retained; cleanup may be deferred
```

These are P5 projection states, not replacements for Run/Attempt/link states. `held_uncertain` retains the previous stage/identity. Idempotency domains: `Kprep=(linkId,allocationId,'prepare')`; `Kcap=(linkId,developerAttemptId,'capture')`; `Kver=(candidateId,planDigest,gateAttemptId)`; `Kjudge` is the existing P4 Attempt/output decision ID; `Kaccept=(linkId,candidateId,receiptId,decisionId)`; `Khandoff=(linkId,candidateId,decisionId,'handoff/1')`. Never use a PID/path alone as a key.

### 13.3 Crash-boundary contract

“Promotion” in this table means logical candidate acceptance/handoff eligibility only. **Physical source or binary promotion is forbidden at every boundary.** `R` means repeat verification; a trusted complete receipt may be reconstructed from existing complete observations, never invented from exit code alone.

| Boundary | Last durable state / owner | Trusted subject / key | Recovery action | Forbidden duplicate | R? / logical acceptance |
|---|---|---|---|---|---|
| P5-C01 authorized before preparation | P2 link/authorization + captured Run; Engine owns enrolled slot reservation | Bound baseline; `Kprep` | Validate Stop/enrollment; commit prep intent then materialize | Second link/slot or Developer launch before prepared | No prior verification; acceptance forbidden |
| P5-C02 slot allocated before Developer | Prep intent or prepared event; Engine owns exact allocation | Baseline and allocation identity; `Kprep` | Validate partial files; complete only safe missing baseline files, or quarantine; then dispatch original scheduled Attempt | Wipe/reallocate or overwrite conflicting content | Verification still required; no acceptance |
| P5-C03 Developer active on Engine exit | Invocation/Attempt/Custody binding and held root; Host owns tree | Baseline + original Developer Attempt; `Kcap` later | P1 reattach original process/spool, enforce Stop/deadline | Second Developer or resetting source | Verify only after certain completion; no acceptance |
| P5-C04 Developer ended before manifest | Ended Attempt/output and Host terminal proof; Engine retains slot | Baseline + observed actual source; `Kcap` | Revalidate no hold/topology, inventory/scope/seal once | Re-executing Developer to recover its result | Verification required; no acceptance |
| P5-C05 captured before verification | Candidate event and verified source objects; Engine owns slot | Exact candidate; `Kver` | Rehash materialization; create verification intent and launch scheduled Gate once | Seal replacement or accept Developer text | Verification required; no acceptance |
| P5-C06 verifier active on Engine exit | Gate invocation/Custody + verification-start event; Host owns whole tree | Sealed candidate/plan; `Kver` | Bounded Gate-specific P1 reattach, recover committed spool offsets and terminal observations | Second launcher/check set while original outcome uncertain | Do not repeat live work; acceptance forbidden |
| P5-C07 verifier completed before receipt | Host terminal/spool + committed observation artifacts (possibly incomplete local capture); Engine retains slot | Candidate/plan/Gate/Custody; `Kver` | Replay remaining durable spool; reconstruct receipt only with every required observation and source/harness check | Infer pass from launcher exit or partial report | No repeat if evidence complete; otherwise fail/incomplete, only explicitly budgeted safe retry; no acceptance yet |
| P5-C08 receipt before Judge admission | Receipt + Gate outputs/transition transaction; Engine owns sealed subject | Candidate + receipt; `Kjudge` | Verify refs/current integrity and open one existing P4 attention | Rerun checks or create duplicate Judge for unchanged cursor | No repeat if still valid; acceptance only after Judge |
| P5-C09 Judge active on Engine exit | P4 attention/input + Judge Custody; Host owns tree, Engine reservation persists | Same candidate/receipt/cursor; `Kjudge` | Existing P4 Judge reattach; after terminal recheck source and attention | Second Judge/accepting another Attempt | No repeat if valid; decision still required |
| P5-C10 Judge accepts before P2 reconcile | P4 decision + extended P2 approval CAS committed together; Engine retains source | `Kaccept` approval refs | Recheck Stop/integrity, existing outcome reconciliation/Parent CAS, then idempotent handoff | Second logical acceptance/retry/handoff | No repeat if valid; permitted subject to current gates, no binary action |
| P5-C11 Parent Stop during verification | Parent Stop + invalidation/link state; Host may still own verifier | Candidate remains evidence; `Kver` plus Stop cursor | Existing P2 Stop delivery/recovery; retain until tree ended | Late acceptance, continuation or another verifier | No automatic repeat; acceptance forbidden |
| P5-C12 source changes after verification | Old receipt remains historical; invalidation event/revision when observed | Old sealed candidate; new materialization matches no eligible candidate | Mark invalidated, supersede attention/eligibility; retain both evidence and changed directory | Rebind old receipt or silently reseal | Old receipt cannot accept changed source; new explicit candidate needs full checks |
| P5-C13 Host unavailable / termination uncertain | Original Attempt/binding/held root + unresolved evidence; Host ownership unknown to Engine | Last sealed identity if any; same invocation key | Existing custody hold reconciler only; record one stable unresolved revision, await authoritative proof | Relaunch, release, cleanup, pass receipt or approval | No repeat until certainty; acceptance forbidden |
| P5-C14 repeated startup | Last committed stage/Run/link + existing holds; same owner | All original keys | Pure projection replay + predecessor CAS; reattach by existing IDs | Extra logical capture, command, approval, retry, handoff or journal churn | No repeat solely for restart; current gates govern |
| P5-C15 accepted, P6 has not consumed | Approval/handoff/artifact refs + retention event; Engine owns no live process | Accepted immutable source; `Khandoff` | Verify retained graph/status; expose same handoff, honor later Stop/revocation | New Repair, unrequested P6 execution or automatic merge | No P5 repeat if valid; later P6 revalidates independently |

### 13.4 Compatibility

All new policy, artifact, receipt and Gate-mode shapes are versioned and strict. No policy is backfilled into old Runs or links. Absent `selfRepair` means exactly existing P2/P4 behavior, including expected-digest Repair. Historical approvals without P5 refs never become P5 handoffs. P5-capable runtimes reject unknown/unsupported P5 versions before recovery or dispatch and retain held work/evidence. Source artifact schemas reject unknown versions.

**Downgrade restriction:** current P4 does not universally revalidate future workflow schemas/capabilities at startup; `publishedDefinitionIntact` verifies captured hashes, not future semantics. Therefore this design does not claim an unmodified old reader will safely reject a stored P5 Run, especially after its verification Gate succeeded. A profile with P5 authorizations, reservations, pending acceptance, accepted handoff eligibility or retained P5 state requiring interpretation may be opened only by a compatible P5 reader. Merely settling processes does not make downgrade safe. Enrollment records a minimum reader capability in trusted installation/profile metadata; initial P5 enrollment is unsupported where the launcher can automatically fall back to an incompatible Engine. No P5 path requests such rollback. Any later P6 lifecycle/version-admission path must enforce that minimum before selecting an older Engine; the P6 mechanism itself is outside this design. Manual launch of incompatible software against the profile is excluded, not purportedly blocked by a new SQL schema version or a marker old code never reads.

## 14. P5-08 — Retention, rejection and cleanup

| Event | Logical outcome / retention rule |
|---|---|
| Verification passes | Seal and receipt retained, candidate reserved for Judge; no source publication |
| Judge approves | Retain complete source graph, approval and handoff; stop no extra process and release only proven-ended Custody holds |
| Judge rejects / scope/check failure | Record rejection, retain bounded diagnostic/source evidence and slot; cannot become a handoff |
| Owner/Parent Stop | Mark ineligible for new acceptance/continuation/consumption; deliver existing Stop; preserve historical facts |
| Engine exits | Retain every reservation and Host hold; P1/P2 recovery owns next action |
| Host unavailable or descendants uncertain | `held_uncertain`, no cleanup or workspace release, even if leader PID exited |
| Incomplete source/artifact capture | No valid candidate/receipt/handoff; preserve partial owned slot, report incomplete |
| Storage corrupt/unavailable | Fail closed on reads/transactions; do not invent success or clean evidence |

Approved evidence lives in the existing content store, not a lingering verifier/Developer process. Record location as `{sourceObjects:available|missing|corrupt, developerMaterialization:retained|missing|changed, verificationMaterialization:retained|missing|changed, slotReservation:held|retired, revision}`. Paths are hints; each use verifies object content and current status.

Initial P5 **does not automatically recursively delete or recycle candidate slots**, including rejected ones. Once processes are conclusively ended, release their Custody process holds while retaining the P5 allocation reservation; mark physical cleanup `deferred` for explicit maintenance. This deliberately avoids claiming atomic delete safety from current Node path checks. A future cleanup primitive must prove native handle-bound/no-follow deletion or an equivalently proven isolated topology before automatic release/reuse. No global scan, stale PID inference, age-only expiry, Git worktree prune or historical test-root cleanup is authorized.

Profiles cap files/bytes, attempts and number of enrolled slots. Preflight reserves enough configured storage allowance for baseline, candidate, verification materialization and bounded outputs; allocation failures stop the Repair. If the local retained-evidence cap is reached, refuse new P5 enrollment/admission and report an actionable maintenance state, not delete accepted evidence or infer cleanup permission. No indefinite background retention worker is introduced.

## 15. P5-10 — Security boundaries and threat model

### 15.1 Boundary classification

| Boundary | Classification | Exact guarantee / limitation |
|---|---|---|
| P4 request/Judge/P2 acceptance | **Engine enforced** | Normal workflow/API transition validation, captured profile, actual live Attempt and transaction; model bytes are data. AR01 bearer theft can impersonate Owner through public APIs. |
| Candidate materialization/scope/identity | **Engine enforced + verified after execution** | Engine writes only its slot; inventories actual content, rejects out-of-scope changes and binds exact objects. Does not stop arbitrary same-user writes elsewhere. |
| Custody launch, epoch, deadline, tree and spool | **Host enforced**, using **OS process containment** | Owns launched process/descendants under supported Host platform semantics; tree evidence controls hold release. Job membership is process lifetime control, not filesystem/credential protection. |
| Source seal/object store integrity | **Engine verified**; physical integrity is an **accepted trust assumption** | Objects verify on read and cannot change identity silently. Same-user store/Engine compromise can defeat the control plane; hashes alone are not an independent signature. |
| Harness/plan independence | **Engine enforced** for selected plan/command/receipt; outside-candidate installation integrity is **policy/trusted deployment**, not proven OS isolation | Candidate edits cannot change captured criteria through Engine paths. Host checks launcher executable only; Engine checks scripts and dependency closure. Hostile same-user tampering remains outside assurance. |
| Developer/Judge CWD and “read-only review” instructions | **Policy-only** | No authority beyond normal roles; instructions/CWD do not deny filesystem access. Drift checks detect observed changes. |
| Stable topology and no outside writers | **Supported-profile restriction**, checked at boundaries | No atomic multi-file snapshot or hostile swap protection is claimed. Unverifiable/changed topology fails closed. |
| Owner/Host credential hygiene | **Engine/Host enforced** for env/prompt/log handoff; credential file protection is **OS deployment-dependent / AR01 residual** | Scrub tokens from child environments, use existing scoped Host channels. Same-user code may still read accessible files/memory or use stolen public bearer authority. |
| Running binary/source replacement | **Engine enforced** absence of P5 transition | P5 has no merge/ref/promotion/activation operation. Same-user external writes are still possible under AR01; Host's installed executable is not automatically updated. |
| Physical cleanup | **Fail closed / deferred** | P5 does no automatic recursive delete. Existing cleanup race remains outside P5's authority. |

The supported initial profile is local, single Owner, cooperative same-user workflows and reviewed/pinned tool/dependency inputs. It explicitly excludes a guarantee for arbitrary untrusted commands, candidate programs intended to attack the verifier/Engine, concurrent hostile filesystem changes, credential exfiltration or OS compromise. A profile requiring such guarantees is **not admissible as protected P5** until a separate OS principal/container/VM or equally proven mechanism denies original source, control store and credential access and preserves trusted result channels. This is a future deployment profile, not a new P5 sandbox framework or a retroactive restriction on ordinary P1–P4 Full Access.

### 15.2 Required threat scenarios

P = prevented on Engine/Host-controlled paths; D = detected; F = fail closed; R = accepted AR01/profile residual; O = stronger OS isolation required for a hostile-code guarantee.

| # | Threat | Disposition and proof boundary |
|---|---|---|
| 1 | Developer edits original live workspace | P: Engine only targets private slot; no copy-back/ref operation. D: enrolled-source audit may reveal drift. R/O: arbitrary same-user CLI can write original files; E2E-02 cannot claim OS denial. |
| 2 | Developer modifies its own tests | P: installed/baseline mandatory assertions and coverage floor remain captured. D/F: sensitive scope + manifest; candidate tests are supplemental. R/O for attacking the outside harness. |
| 3 | Developer changes verification policy | P/F: immutable plan/ref and enrollment equality checked before launch and approval; candidate policy file is future source only. |
| 4 | Forged passing report | P/F: only Engine receipt event + exact Gate/Custody observations authorize; reject workspace/provider reports. R/O if trusted Engine/store/harness itself is compromised. |
| 5 | Source changes after checks | D/F: sealed objects, repeated full digest/topology checks, cursor invalidation. Transient hostile swap/restore remains R/O. |
| 6 | Symlink/junction escape | D/F: reject source links, reparse ancestors, hardlinks/aliases and invalid names; no follow on Engine-managed paths where supported. Unsupported native identity/read semantics refuse topology. |
| 7 | Path replacement between check/use | D/F for observed changes; stable topology/no outside writer is a required restriction. No privileged promotion/delete. R/O for hostile races, not “fixed” by repeated hashes. |
| 8 | Owner Token / Host credentials access | P: no inherited secret, prompt or artifact disclosure from Engine. R/O: AR01 same-user filesystem/memory and stolen bearer remain possible; token auth is not human attestation. |
| 9 | Direct Engine/Host state mutation | P: scoped APIs, publication/Attempt authority, Host secret/epoch and receipt checks. R/O: arbitrary same-user DB/file/memory manipulation not sandboxed. |
| 10 | Output instructs bypass of Judge/P2 | P: typed data only; no raw transcript command parser gains P5 authority. Judge output still undergoes exact decision validation. |
| 11 | Malicious dependency/test executes code | P: no uncaptured install hooks/network dependencies, no candidate code in receipt writer; terminate owned tree. R/O: execution is not confined against same-user attacks; hostile inputs excluded. |
| 12 | Stale receipt replay for another candidate | P/F: candidate/base/profile/plan/Run/link/Gate/Custody refs and complete object graph checked; no path-only or report-only grant. |
| 13 | Foreign/stale Repair Judge | P/F: existing P4 designated live Attempt/publication/attention/cursor plus P2 exact link and P5 subject. |
| 14 | Stop races with verification/approval | P: Store transaction serialization, existing Stop supersession and P2 continuation CAS. F: late approval/handoff consumption. Historical prior acceptance is not erased. |
| 15 | Descendant retains candidate after cancellation | Host process-tree evidence required; F: hold and cleanup deferral until ended. Leader exit/timeout is insufficient. |
| 16 | Candidate requests binary activation | P: no P5 action/Host lifecycle delivery; Repair text/receipt is not a lifecycle intent. P6 owns later authorization. R/O for external same-user tampering. |
| 17 | Changes outside captured allowed scope | D/F: full actual manifest, hard default denies, sensitive scope and metadata/coverage checks; Judge cannot expand it. Arbitrary writes outside slot remain R/O. |
| 18 | Two Engine generations accept candidate | P: runner lock, Host attach epoch, same transaction predecessor/decision/link CAS. Stale output rejected; no duplicate approval/resume. Arbitrary rogue store writer remains R/O. |

Residual risk is not converted into a claim that a hostile Developer is contained. E2E tests must explicitly distinguish Engine refusal from OS denial; hostile-code guarantees are absent, not “proven” by a cooperative fixture.

## 16. Failure and outcome semantics

P5 adds domain statuses, not a new universal failure classifier. Proposed codes below occur in P5 records (`status`, `reasonCode`) and bounded `rawCode` where appropriate. Attempt/Run failure uses existing P3 canonical code/category/provenance and revision conventions. A successful capture or approval is an event, not a fabricated failure outcome.

| Domain status / reason | Persistence / existing semantics | Next action |
|---|---|---|
| `candidate_prepared` | Prepared event + baseline/slot refs | Developer may dispatch |
| `candidate_scope_rejected` | P5 invalidation + P3 `output_contract`, source=workflow | Deterministic blocker; no acceptance |
| `candidate_source_invalid` | P5 invalidation; `input_unavailable`/`workspace_binding_mismatch`, or `corruption` for object failure, source=engine | Block and retain |
| `verification_passed` | Engine receipt + successful Gate Attempt | Eligible for Repair Judge only |
| `verification_failed` | Failed receipt + Gate failure; existing `process` or `output_contract`, source=workflow | No approval; bounded P4 failure attention if useful |
| `verification_incomplete` | Receipt and capture/timeout facts; `capture_failed`, `capture_limit` or `timeout` with actual provenance | Block; no synthetic completion |
| `host_process_uncertain` | Existing hold/unresolved/P3 `custody_unresolved`, source=host/recovery, certainty=unresolved | Reconcile same invocation; no retry/release |
| `candidate_changed_after_verification` | Invalidation revision, P3 `lifecycle_candidate_mismatch` with P5 detail, source=engine | Supersede attention/handoff eligibility |
| `judge_approved` | Existing P4 decision and extended P2 approval artifact/CAS | P2 outcome/continuation gates; no source mutation |
| `judge_rejected` | Existing rejection event/link outcome | Retain rejected evidence |
| `parent_stopped` | Existing Stop/link/control outcome plus P5 invalidation | Stop linked work, no later accept/resume |
| `candidate_retained_for_p6` | Handoff and retention events | Read-only inspectability; separate P6 request |
| `cleanup_deferred` | Retention/deferred event with exact ownership reason | No deletion/release based on time or age |

P3 must never record `none_proven` for arbitrary Developer/test effects just because a process exited successfully. Source changes are confirmed effects inside candidate scope; unrelated effects remain unknown where not proven. Keep unknown effects separate from execution completion and from verified object identity.

Default budget: one candidate/Developer segment and one verification invocation per link; actual finite wall times/file/byte/output/slot bounds are mandatory enrollment inputs, never unspecified infinity. P4 Judge attempts/expansions retain captured maxima. Unchanged evidence produces no new attention/model turn or repeated failure event. Exhaustion yields a stable held/failed status and normal Owner-visible reason. Questions can clarify intent, but cannot reset exhausted budgets, widen scope or override deterministic blockers. A new incident/admission requires meaningful new evidence and explicit captured policy; no same-incident reflection loop.

## 17. P5-11 — Minimal P6 handoff

After the P4 acceptance transaction and P2 Repair outcome reconciliation, publish one `ProtectedSelfRepairHandoff/1` artifact/event. It may be published while Parent retry is blocked by `never`; report the actual link/continuation state separately. Its minimum fields are:

```text
{ kind, schemaVersion:1, handoffId, candidateId,
  baseline:ArtifactRef, baselineId, repositoryIdentity, baseCommit,
  sourceBinding:ArtifactRef, candidateSourceDigest,
  candidateManifest:ArtifactRef, sourceManifest:ArtifactRef,
  changeManifest:ArtifactRef, verificationPolicy:ArtifactRef,
  verificationInputs:ArtifactRef,
  verificationReceipt:ArtifactRef, enrollmentManifest:ArtifactRef,
  parentRunId, repairRunId, linkId, incidentId,
  parentPublication, repairPublication,
  judge:{attemptId, attentionKey, decisionId, decisionArtifact:ArtifactRef},
  p2:{authorization:ArtifactRef, approval:ArtifactRef,
      repairOutcome:"succeeded", linkState, continuationStatus, failedNodeRetry},
  provenance:{hostIdentity, lifecycleGeneration, journalCursors},
  retention:{status:"retained", sourceObjects:"available", revision,
             workspaceLocationHint},
  authority:{sourceCandidateAccepted:true, sourceApplied:false,
             branchPublished:false, productionBuilt:false,
             binaryInstalled:false, activated:false},
  consumptionStatusReference:{repairRunId, eventCursor}, createdAt }
```

`handoffId` is `Khandoff` hashed with its version. Engine verifies the complete reachable object graph and current eligibility before recording it; P2 failure/rejection/Parent Stop/missing evidence blocks publication. Handoff need not reference itself or predict the future link state. Later retention/invalidation/Stop events are authoritative updates to its consumption status.

P6 must independently check schemas/content graph/digests, exact candidate/base/plan/receipt/Judge/P2 relationships, current Stop/invalidation/retention status and installation/source lineage. It reconstructs source from content objects, not from a trusted mutable path. If live Engine state is unavailable, P6 must obtain a separately verified current eligibility record or fail closed; a copied historical JSON file alone cannot establish that no later Stop occurred. P6 revalidates its own build/attestation/activation policy. P5 does not prescribe that pipeline, signing, launch manifest or activation implementation.

## 18. Ordered implementation packages

All files below are **expected future touchpoints**, not edits authorized in this task. Proposed new modules have no existence claim. Each package closes only after its stated proofs; later packages depend on earlier contracts.

| Package / dependency | Scope and exact touchpoints | Principal risk / required proof |
|---|---|---|
| **P5.1 — publication/policy** | `docs/schemas/workflow.schema.json`, `runtime/core/validate.mjs`, Engine publication/capture/runtime guards, `linkedRepair.mjs` profile capture; proposed strict P5 artifact schemas registered in `runtime/core/schemas.mjs`, installed enrollment/source-binding loader; `src/types.ts`, docs validator/fixtures | Prove acyclic source/runtime binding and profile construction, strict enrollment, exact publication/prompt/plan/input capture, direct-start bypass refusal, incident eligibility, no role-only grant and legacy compatibility. No new SQL. |
| **P5.2 — source and candidate**, after P5.1 | Proposed `runtime/core/protectedSelfRepair.mjs` installed into Engine; reuse `canonical.mjs`, Store, workspace isolation, narrow safe Git/source helpers; Engine workspace admission/rebind and Developer settlement; bounded Windows identity helper if needed | Prove clean baseline, original/untracked/ignored preservation, exclusive single-use slot, actual whole-tree diff/metadata/path safety, sealed content and no-op/scope refusal. No Delivery commit/ref path or cleanup framework. |
| **P5.3 — independent verification**, after P5.2 | New Gate mode in `docs/schemas/workflow.schema.json`, `runtime/core/validate.mjs` (`nodePorts`, mode-specific semantic/capability checks), `runtime/core/gate.mjs` and Engine dispatch; `src/types.ts`, `src/model.ts`, `src/nodes.tsx`, `src/Inspector.tsx`, `shared/replay.mjs`/types and docs validator for mode-safe rendering; proposed installed `runtime/verification/p5Verifier.mjs`; narrow `custody.mjs` Gate eligibility/reattach/settlement and Engine restart gates; `streams.mjs`/execution evidence; Host configured executable allowlist | Prove all required observations/inputs/tools bind exact source; tampered tests/reports cannot lower floor; original Gate Attempt survives real Host Engine replacement; no malformed/partial pass; descendant/Stop/Windows tests. Rust protocol need not change; source review must confirm. |
| **P5.4 — P4/P2 integration**, after P5.3 | `workflowJudge.mjs` context/catalog/cursor/admission, P5-only `request_evidence` permission, required-dossier delivery and answer-follow-up carry; `linkedRepair.mjs` phase-specific adaptive apply/outcome/resume predicates and extended approval artifact; Engine Judge settlement and `stopRun` P5 invalidation before terminal return, independent of P2 callback filters; journal/artifact schemas | Prove deterministic gates and actual candidate subject binding, bounded complete diff delivery (including oversized/missing detail refusal), stale/foreign/Stop rejection including terminal/never Parents, one atomic decision/effect, captured `never` and P3 safe-retry preservation. |
| **P5.5 — recovery/handoff**, after P5.4 | Existing `initialize/recover/reconcileContinuations` hooks, same proposed P5 module, existing Run projection in `engine.mjs`/`runner.mjs`; artifact/provenance reads, `mcp/bridge.mjs`, `src/App.tsx`/`Inspector.tsx`/`types.ts` | Prove C01–C15, retained object graph, no duplicate logical accept, stable bounded status/cleanup deferral and independently reconstructable P6 output. No activate endpoint. |
| **P5.6 — verification/closure**, after P5.5 | Focused P5 fixtures/tests adjacent to `parent-repair-*`, `workflow-judge-*`, `custody-*`, source/Git/Windows integration; schema fixtures/docs; `lifecycle-host` tests if required; test tier catalogue | Fresh-context read-only implementation review, E2E-01–18 and negative cases below, then full final regression/Host/docs/build gates on frozen implementation source when implementation is authorized. No paid LLM dependency for safety proofs. |

Major implementation dependency is the narrow Gate/Custody extension, not a new verifier service. If maintainers choose a different existing execution slot, they must preserve the same original-Attempt/Custody/receipt recovery proofs; a best-effort child-process helper is not an equivalent implementation.

## 19. Acceptance-test architecture

These are **future test designs, not passing test claims**. Use deterministic provider fixtures and real Host processes for lifecycle proofs; paid LLM inference is unnecessary. Every test records exact source/plan/artifact identity and asserts both the intended effect and absence of forbidden acceptance/continuation/activation.

Layers: **D** deterministic Engine/SQLite; **F** filesystem/Git integration; **H** real Rust Host/Custody; **W** native Windows identity/junction/descendant integration; **N** negative authority.

| Proof | Layer / reproducible stimulus | Required assertion |
|---|---|---|
| P5-E2E-01 pinned baseline | D/F: enroll B1, change HEAD/dirty input before request, substitute runtime provenance; happy case reconstructs B1 | Valid request uses exact committed blob/source manifest; mismatched/dirty/running-source binding refuses before Developer; user files unchanged. |
| P5-E2E-02 user source preserved | D/F: original has unrelated tracked/untracked/ignored fixture files; exercise refused dirty source and normal private candidate writes | Engine never stages/commits/copies back; originals match initial bytes/index/HEAD. Include explicit boundary test documenting same-user arbitrary write capability; do **not** call it OS prevention. |
| P5-E2E-03 actual manifest | F: deterministic Developer adds, modifies and deletes binary/text files; lies in its output list | Full independently derived manifest matches bytes/digests/modes; unlisted actual change included; rename is delete+add; no-change rejected. |
| P5-E2E-04 scope/path refusal | D/F/W/N: protected path, traversal, case alias/device/ADS path, symlink/junction/reparse ancestor, hardlink, executable change | Refuse before trusted source capture/acceptance; retain exact slot; never access original as an Engine write target. Real junction tests run outside mocked POSIX-only fixtures. |
| P5-E2E-05 forged verification | D/H/N: Developer emits passing JSON/forged receipt; edits candidate tests/plan/scripts; launcher exits 0 without assertion records; baseline B passes while broken C has a green self-edited suite | No Engine-issued complete receipt, no P5 success/approval; installed coverage/plan unchanged; protected check must fail on C and its subject/derived-tree manifest must prove C was exercised. |
| P5-E2E-06 mandatory failure | D/H: one required check fails; optional passes; inject timeout/missing stage/spool limit and flaky retry | Each non-complete case blocks acceptance. Default retry count stays zero; declared retries preserve failed observations/aggregate rule. |
| P5-E2E-07 exact verified source | F/H: pass checks on C1, swap candidate/source manifest/plan/tool/input/receipt refs to C2 | Receipt binds C1/base/plan/Gate/Custody/output/environment; every mismatch fails eligibility. |
| P5-E2E-08 mutation after checks | D/F/W: mutate Developer or verification source after pass, during Judge, before approval/recovery; replace root | Integrity revision invalidates attention/receipt eligibility; no approval/handoff for drift; sealed C1 objects remain identifiable. Transient hostile races remain outside claimed assurance. |
| P5-E2E-09 correct Judge | D/H: scripted designated Repair Judge requests exact issued dossier then accepts complete passing C1; inject initial premature accept and oversized/missing dossier | Accept only after required detail delivery under existing 16/64/256 KiB and one-expansion limits; one extended P2 approval/P5 binding commits atomically; `never` retains handoff and blocks retry, `explicit_safe` still uses P3/Host gates. |
| P5-E2E-10 stale/foreign authority | D/N: Parent Judge, foreign Repair, stale Attempt/cursor, ordinary role-only Judge, direct Gate/start/Owner-link bypass | No approval/link effect; no privilege from schema-valid model output; current source/profile/Run binding required. |
| P5-E2E-11 Developer Engine replacement | H: kill Engine A with fixture Developer tree active, start B then C | Same Run/Attempt/Custody/PID+creation identity; preserved spool; no second Developer, seal once after tree ended. |
| P5-E2E-12 verifier Engine replacement | H/W: kill A during deterministic Gate, B reattaches; fault after terminal before receipt and after receipt before Judge | Same Gate Attempt/Custody and check execution; full spool reconstructs one receipt; incomplete evidence cannot become pass; no duplicate launcher. |
| P5-E2E-13 Parent Stop | D/H/N: Stop during verifier/Judge, before approval, after approval before reconcile/handoff, after never-blocked handoff and after resumed Parent becomes terminal; repeat Stop | Stop-first prevents acceptance; accept-first preserves historical decision but prevents later continuation/consumption; P5 invalidation precedes terminal early return and does not depend on P2 active-link filter; replay is inert; existing P2 recovery completes active Stop after callback loss. |
| P5-E2E-14 uncertain tree hold | H/W: descendant outlives leader, Host outage/refusal, incomplete drain after cancellation | Workspace remains held/reserved and no cleanup/relaunch/approval; only authoritative tree-ended evidence releases process hold. |
| P5-E2E-15 repeated recovery | D/H: fault-inject every C01–C15 boundary, repeated starts and stale Engine decisions | Predecessor CAS/receipt keys give one logical capture/approval/handoff/retry; never claim exactly-once arbitrary external effects. |
| P5-E2E-16 P6 identity | D/F/N: reconstruct accepted source in fresh directory from handoff, remove/mutate/replay object/approval/plan, Stop after handoff | Reconstructed digest equals accepted source; relationships and current status independently checkable; missing/corrupt/stopped state refuses consumption. |
| P5-E2E-17 legacy compatibility | D/H: old expected-digest P2, non-P5 adaptive P4, ordinary Gate/role-only Judge, old DB fixture; incompatible-reader enrollment configuration | Identical legacy behavior and no identity backfill; P5 reader rejects unknown P5 versions; enrollment refuses automatic incompatible-reader fallback. No claim that unmodified old P4 safely recovers stored P5 state; no SQL migration needed. |
| P5-E2E-18 no activation | D/H/N: return lifecycle strings/activation payloads from Developer/Judge/test output; inspect Host calls and Git/binary state | No P5 lifecycle request, `update-ref`, merge, running-file replace, production install/restart or Host upgrade; handoff authority flags remain false. |

Additional focused tests: secret exclusion and no auto-config reads; committed blob versus CRLF/filter/skip-worktree identity; dirty snapshot refusal; common-dir/worktree aliases; partial preparation conflict; idle slot reservation; object preexistence corruption verification; installed harness/descendant tool drift; captured environment values; malformed/duplicated check IDs, missing assertions and output framing injection; sensitive scope union; source/module binding mismatch; bounded evidence and no-progress/repeated failure; retention capacity refusal; typed Repair question resumes only Repair Judge and cannot widen policy; question after dossier expansion, restart after answer, original dossier carried into new attention, and refusal of any reset expansion allowance or missing lineage. These augment the 18 required proofs rather than replacing them.

## 20. Independent architectural review

One fresh-context independent reviewer read the full task, draft and current Engine/P2/P4/Custody/Host, workspace/Git/source/artifact/verification mechanisms, migrations, acceptance register/ADRs, P1–P4 reviews and Native Windows lifecycle limitations. The reviewer made no file changes and ran no tests, provider inference or Repair. After draft corrections, the same reviewer rechecked the affected contracts and returned **`P5 ARCHITECTURE READY FOR IMPLEMENTATION` within the explicit cooperative execution profile**, with no unresolved Critical, High or contract-breaking Medium findings. This is architectural review, not evidence of implemented P5 behavior.

### 20.1 Findings and resolutions

| ID / severity | Finding and source evidence | Resolution verified by reviewer |
|---|---|---|
| P5-R01 — High, resolved | A protected test could pass against baseline B while claiming candidate C. `runtime/tests/helpers.mjs` imports `../runner.mjs`/`../core/*` relative to the helper file; CWD alone does not select candidate code. | §10.2.1 specifies per-check subject adapter/entrypoint/closure evidence, constrained protected overlay with a separate execution-tree identity, and mandatory B-passes/broken-C-fails proof (E2E-05/07). |
| P5-R02 — Medium, resolved | Literal reuse of open/pending approval predicates after acceptance would block valid P2 outcome/resume/handoff, including captured `never`. Existing P2 transitions require different states. | §12.1 separates common evidence predicates from phase-specific link/Run/CAS preconditions and permits `never` handoff only with the exact durable retry-policy block; no generic blocked-state shortcut. |
| P5-R03 — Medium, resolved | Current Repair approval cannot `request_evidence`, catalog excludes >64 KiB artifacts, and current answer application drops expansion/reset counts. Manifest refs alone would not deliver required review detail. | §12.1 explicitly adds P5-only existing-action permission, complete bounded dossier/chunks, required-delivery gating and question-follow-up lineage carry without refreshed subject allowance. E2E-09 and focused question/restart proofs cover the bounds. Legacy behavior is unchanged. |
| P5-R04 — Medium, resolved | Current terminal `stopRun` returns early; P2 after-Stop selects active/failed/completed/accepted links, excluding never-blocked and resumed handoffs. | §12.2 requires P5-only idempotent eligibility invalidation inside Stop's transaction before terminal return and independently of P2 callback filters. E2E-13 covers post-acceptance/never/terminal and repeated Stop. |
| P5-R05 — Low, resolved | Old-reader rejection was overstated: current `publishedDefinitionIntact` checks hashes, not unknown future semantics. | §13.4 explicitly prohibits incompatible-reader deployment/downgrade while P5 state requires interpretation, even after processes end; it makes no claim that current P4 enforces future refusal. |

The author also corrected a draft artifact-reference cycle: static baseline/profile/plan cannot include their enclosing Parent publication, future Runs/incident or installation manifest that refers back to them. Reviewer verified the acyclic construction and static versus per-admission binding split (§§6.1, 7.3, 8.3). Reviewer identified and author independently confirmed the current CRLF/raw-blob enrollment limitation, now explicit in §§21, 23. No user files were normalized.

### 20.2 Mandatory reviewer questions

| # | Question / verified disposition |
|---|---|
| 1 | Reuse P2/P4? **Yes**; existing coordinator and Judge authority remain authoritative. |
| 2 | Can Developer access source outside candidate? **Yes under arbitrary same-user execution**; that hostile-code guarantee is excluded, not falsely enforced. |
| 3 | Accurate protection claims? **Yes**; Engine/Host/OS/policy/post-check/residual classifications are explicit. |
| 4 | Can candidate weaken criteria? **Not through P5 paths**; captured plan/coverage remain fixed. Same-user control-plane compromise remains outside assurance. |
| 5 | Forged/stale receipt path? **No lawful path**; exact source/policy/input/Run/Gate/Custody and Engine issuance are required. |
| 6 | Immutable identity after verification? **Yes for sealed objects**; materialization drift invalidates eligibility. |
| 7 | Judge subordinate to deterministic gates? **Yes**, including required evidence delivery. |
| 8 | Owner Stop blocks acceptance/continuation? **Yes**, with the explicit hook also revoking unconsumed handoff eligibility. |
| 9 | Replacement duplicates/loses candidate? Durable intents/original Custody/CAS prevent **logical** duplication; uncertain external effects remain held. |
| 10 | Cleanup with uncertainty safe? **Yes**; hold retained, automatic recursive deletion deferred. |
| 11 | User changes preserved? **Yes on Engine-managed paths**; dirty inputs refused, no original-source writes. AR01 remains explicit. |
| 12 | P5 mutates running binary? **No P5 transition does**; arbitrary external same-user writes are not OS confined. |
| 13 | P6 handoff independently verifiable? **Yes**; content graph, verification, Judge/P2 and current eligibility are bound. |
| 14 | Fits supported sequential P4? **Yes with the explicit narrow Gate/Custody extension**, not with unsupported Loop/Map/Task/Context. |
| 15 | SQL necessary? **No** for serialized event/predecessor CAS and existing P2 uniqueness. |
| 16 | No-progress/repeated failures bounded? **Yes**, finite candidate/invocation/evidence/time/storage/Judge budgets and unchanged-evidence suppression. |
| 17 | Legacy behavior retained? **Yes**, absent enrollment; incompatible-reader downgrade is explicitly unsupported. |
| 18 | Tests distinguish claims from enforcement? **Yes as a test architecture**, including candidate subject selection, Host recovery, Windows topology and negative authority. |
| 19 | AR01 accurate? **Yes**, bearer impersonation and same-user filesystem/control-plane risk remain; no human-attestation claim. |
| 20 | Unnecessary complexity? **No competing coordinator/service/store**; additions address demonstrated source, verification, review-detail and lifecycle gaps. |

**Review disposition:** one High, three Medium and one Low finding resolved; zero unresolved blocking findings. Future implementation review and real P5 acceptance proofs remain required by P5.6.

## 21. Remaining risks and limits

1. AR01 and same-user Full Access are retained. P5 cannot prevent a malicious CLI from accessing writable original source, credentials or the control plane. Policy scope and digest gates are not hostile-code isolation.
2. Stable local topology/no outside writer is an initial supported-profile condition. Node pathname checks are not atomic snapshot/promotion/delete primitives. Automatic physical cleanup is deferred.
3. Clean committed source and explicit runtime-source provenance are required. Dirty effective source, symlinks/submodules, network roots, uncaptured filters/dependencies/config and ambiguous Windows identities are excluded initially.
4. The deterministic Gate/Custody execution binding, source enrollment/capture and candidate receipt gates are new implementation work. Historical P4 test totals do not prove them.
5. Independent verification proves the captured checks and exact subject, not correctness of every behavior. Protected assertion coverage and tool integrity must be reviewed at enrollment.
6. Accepted candidates can accumulate. Finite slots/storage admission limits bound this; physical reclamation remains explicit maintenance.
7. Parent continuation may still be blocked, and continuing the old binary does not apply a source fix. P6 owns all later build and activation decisions.
8. This audited checkout has `i/lf w/crlf` for Engine/Gate and system `core.autocrlf=true`. It does not currently satisfy the initial byte-identical clean-source enrollment profile. Any future untransformed source checkout/enrollment is explicit preparation preserving this checkout; P5 does not normalize or rewrite the user's files. Architecture readiness is not a claim that this source-mode deployment is already eligible.

These are explicit supported-profile limits and proof obligations, not hidden authority gaps or claims that P5 is already implemented.

## 22. Readiness and completion criteria

**`P5 ARCHITECTURE READY FOR IMPLEMENTATION`**

The implementable contract selects Option A, exact clean source and private sealed candidate identity, captured independent verification with actual subject binding, deterministic P4/P2 acceptance and complete recovery/Stop rules. Fresh-context review found no remaining blocker after the recorded corrections. Only this architecture file was created; production implementation and future P5 tests remain separate authorization and acceptance gates. Readiness applies to the bounded cooperative profile, with AR01, untransformed source enrollment, compatible-reader deployment and deferred physical cleanup explicit; it is not a claim that the current checkout is already eligible or that a hostile-code sandbox exists.

| Completion criterion | Design location |
|---|---|
| Scope separate from P4/P6/P7; entrypoint/authority exact | §§1–6, 12, 17 |
| Unambiguous baseline and actual candidate identity | §§7–9 |
| User preservation, real isolation limits, allowed/protected scope | §§8, 15 |
| Pre-captured plan, independently issued exact-source receipt | §§10–11 |
| Judge cannot waive failed checks; P2 retry unchanged | §12 |
| No running source/binary replacement | §§1–2, 12, 17 |
| Host uncertainty, Engine replacement, Stop and cleanup | §§13–16 |
| Accepted retention and independently verifiable P6 artifact | §§14, 17 |
| Ordered minimal implementation and all 18 test designs | §§18–19 |
| Independent review has no unresolved blocker | §20, satisfied |
| No production implementation; Git index/user files preserved | §23, satisfied |

## 23. Git state, validation and source map

Initial read-only Git audit:

- Workspace: `C:\my\2026\deszo_agent_orche`.
- Branch: `codex/adr-0003-0005-completion`, tracking `origin/codex/adr-0003-0005-completion`, ahead/behind `0/0` at audit.
- HEAD: `a41d03ffedf9ce55aab3e791d4e193f3bda0127d`; tree: `4c9a46d0974ff2fcb55d37870467d6b459472210`.
- `git status --porcelain=v2 --branch --untracked-files=all`: clean at task start; no staged or tracked/untracked changes.
- `git worktree list --porcelain`: one registered worktree, this checkout. No worktree was created, moved or removed.
- Read-only `git ls-files --eol runtime/core/engine.mjs runtime/core/gate.mjs` reports index LF / worktree CRLF; `git config --show-origin --get core.autocrlf` reports `true` from `C:/Program Files/Git/etc/gitconfig`. This is a concrete initial-enrollment limitation (§21), not a dirty-worktree change or permission to normalize it.
- No `AGENTS.md` was found in the workspace or its ancestor instruction paths during the audit.
- No stage, commit, push, merge, rebase, reset/clean, source repair, credential change, historical artifact deletion or full regression was performed.

Only this architecture document was created, as an unstaged untracked file. Final Git verification shows no tracked/index changes and unchanged HEAD. Document validation and final inventory are recorded below.

### 23.1 Audited source hashes (SHA-256)

| Source | Digest |
|---|---|
| `runtime/core/engine.mjs` | `40c66d495f689a0e0caefa3ca54f6719fb9161c0d5386da4252ea22ede28d64d` |
| `runtime/core/workflowJudge.mjs` | `6c0c122f27d7cdaa6929ac1011515c43047b08d5f7c15324e8ba96edf2a646ea` |
| `runtime/core/linkedRepair.mjs` | `b8eae9519ff489ea8c95df6d802e8708afd0dc56870ab8fd8ec1a4a6863e17f3` |
| `runtime/core/custody.mjs` | `3b37f9409c9320c8e1b4bd54fabab413bb628f3eb09db9c998e0a3e725bb0d2c` |
| `runtime/core/branchDelivery.mjs` | `8f329cf82fa31b1ffa3e9c57f9c2583642123a0869cbb59467283dbdf856097e` |
| `runtime/core/workspaceIsolation.mjs` | `9211e0ff09f9d7a772b7ec926386dec293f44436ee2b80f07a6f493de702e005` |
| `runtime/core/store.mjs` | `c7761a96eabc5e768c7f72fc47ed5e9b7b74ac222df8e7345238a0fafb39e1c3` |
| `runtime/core/validate.mjs` | `4985d264eff8ff761eedb636581332a71611ba298cf158a383c8e81b173bdd56` |
| `runtime/core/migrations.mjs` | `1721f4c56b498559a9aa259419c99dea72d8fe520d88f1527c7853649b985e23` |
| `runtime/core/failureOutcomes.mjs` | `c4fbd838ebc168f6335a72cee5a6a3a822c87cf22f249ae4a9fecb97db569ffc` |
| `runtime/core/streams.mjs` | `923d0c7672fa7846df6a6f2f5ac215beb7b191c9d08911566b361be4f06f2b02` |
| `runtime/runner.mjs` | `6c3593ea493f540d9251479232ef6589b775ace43f7810fc75e59b47f20d3b3b` |
| `runtime/host/authority.mjs` | `0e27c4df11a7d63c83a777714e2a1e6488cef4cc7084529b1492eddb37cf43c9` |
| `runtime/host/runtimeHttp.mjs` | `f5793f0361d3a415ee65c71e1e2c0e38fd8555ea9a9e9fb9bb509036b0b81593` |
| `runtime/host/sourceProvenance.mjs` | `c013875872cef56d940fadcbd315d422396dbb65976bb6f4aeff55936dd6cb13` |
| `lifecycle-host/src/custody.rs` | `4ee05b852278cc2021b0efce15b33e1542255fbc94f0cbb28f0e2b60e0267d27` |
| `docs/storage/m22.sql` | `6fabcf99e5456667f2ae278aa3f1fa2feaa6a3751e2439d8e0e60bc31ab61b73` |

### 23.2 Source and decision navigation

- [Engine](../../runtime/core/engine.mjs), [P4 Judge](../../runtime/core/workflowJudge.mjs), [P2 linked Repair](../../runtime/core/linkedRepair.mjs), [Custody integration](../../runtime/core/custody.mjs), [Rust Host Custody](../../lifecycle-host/src/custody.rs).
- [Workspace roots](../../runtime/core/workspaceIsolation.mjs), [Branch Delivery](../../runtime/core/branchDelivery.mjs), [Task snapshot](../../runtime/core/taskRuntime.mjs), [Task command runner](../../runtime/core/taskProcesses.mjs), [Gate](../../runtime/core/gate.mjs).
- [Store](../../runtime/core/store.mjs), [canonical JSON](../../runtime/core/canonical.mjs), [streams](../../runtime/core/streams.mjs), [P3 outcomes](../../runtime/core/failureOutcomes.mjs), [migrations](../../runtime/core/migrations.mjs), [M22](../storage/m22.sql).
- [Validation](../../runtime/core/validate.mjs), [workflow schema](../schemas/workflow.schema.json), [runtime runner](../../runtime/runner.mjs), [legacy Host authority](../../runtime/host/authority.mjs), [Host HTTP](../../runtime/host/runtimeHttp.mjs), [source provenance](../../runtime/host/sourceProvenance.mjs), [build runner](../../runtime/host/buildRunner.mjs), [build attestation](../../runtime/host/buildAttestation.mjs).
- [Run UI](../../src/App.tsx), [Inspector](../../src/Inspector.tsx), [types](../../src/types.ts), [MCP bridge](../../mcp/bridge.mjs), [test roots](../../runtime/tests/test-roots.mjs).
- [Decision register](../DECISIONS.md), [ADR index](../adr/README.md), [ADR-0008](../adr/0008-portable-ephemeral-lifecycle-host.md), [ADR-0009](../adr/0009-workflow-native-judge-and-exclusive-external-input.md).
- [P1 implementation](2026-10-26-p1-durable-workflow-continuation.md), [P2 implementation/D25](2026-10-26-p2-parent-repair-coordination.md), [P3 implementation](2026-10-27-p3-typed-failure-outcomes.md), [P4 architecture and CP-01–CP-05](2026-10-27-p4-workflow-native-judge-architecture.md), [P4.1 integration](2026-10-28-p4-1-policy-integration.md), [P4 final implementation/acceptance](2026-10-28-p4-workflow-native-judge-implementation.md).
- [Resource lifecycle closure](2026-10-27-resource-lifecycle-leak-closure.md), [Native Windows lifecycle audit](2026-10-27-native-windows-resource-verification.md).

### 23.3 Final document checks

- `npm run docs:check` passed, exit 0, after review corrections: 33 schemas, 145 Markdown files, 1,300 local links, zero errors. This is document/schema validation, not P5 implementation acceptance or a new full regression.
- `git diff --check` passed, exit 0. A full scan of the untracked architecture file found zero trailing-whitespace lines; the read-only no-index Git check reported no whitespace errors (its difference exit and existing LF→CRLF warning do not indicate staging).
- Recomputed all 17 audited source hashes against §23.1: zero mismatches. Required matrix inventory contains all 15 crash rows and all 18 P5 E2E rows; all 20 independent-review questions are answered in §20.
- Final `git status --porcelain=v2 --branch --untracked-files=all` reports only `? docs/reviews/2026-10-28-p5-protected-self-repair-architecture.md`; branch/HEAD/upstream relationship is unchanged.
- `git diff --cached --exit-code` and `git diff --exit-code HEAD` both passed, exit 0. No file was staged, committed or pushed; no production code, schema or migration was changed.
- No real Self-Repair, Host/Engine behavior change, binary build/activation, new full regression or historical artifact cleanup was performed. Independent review was read-only. All implementation and acceptance tests in §§18–19 remain future work under separate authorization.

---

# 24. P5 Git-Based Candidate Model — Architecture Amendment

> **Superseded for the target policy (2026-10-29):** [Amendment 25](2026-10-29-p5-managed-git-ancestry-and-host-boundary.md) replaces `sanitized-seed-v1` with `managed-clone-v1` for new candidates and revokes Self-Repair authority over Host/Custody source. This section is kept unchanged as the historical record for `sanitized-seed-v1` artifacts.

**Status:** Additive implementation preparation for the Git-backed candidate substrate. This amendment preserves the source-manifest identity, independent verification, P4 Judge and P2 Parent/Repair decisions above. It does not claim full P5 runtime acceptance or readiness for P6.

## 24.1 Motivation and candidate model

The prior candidate contract sealed a complete source manifest and its SHA-256 identity, but did not give the candidate a private Git commit. The amendment retains that source manifest as the content authority and adds a private, synthetic Git history for review, recovery and later handoff. The Engine continues to decide which candidate source bytes are eligible. Git branch names and commit IDs are evidence, never approval authority.

The approved preparation policy is `sanitized-seed-v1`. It starts a new ordinary repository in the exact enrolled Repair workspace, writes the already sealed baseline files, and creates a synthetic root commit. It does not clone or fetch the original repository. The original base commit and repository identity remain recorded as provenance only; source ancestry is explicitly unverified. Therefore excluded files, credentials and historical objects from the original `.git` directory are not copied into the candidate store.

## 24.2 Branch and commit authority

P5 creates one local branch, `self-repair/<12-hex>`, derived from the durable P2 Repair link UUID. The Engine owns initialization, baseline commit, final staging and candidate commit. The Developer edits files in the prepared source workspace and must not stage or commit Git changes. Before the Engine commit, it compares actual source paths with the sealed change manifest and refuses Developer-staged changes.

The final commit has exactly one parent: the synthetic baseline seed. Its subject and author/committer are Engine-controlled. A durable `self_repair.git_commit_intent` event records the source-candidate reference, prepared-workspace reference, branch, seed, exact source/change manifests and fixed UTC commit timestamp before Engine staging. Repeating this intent reuses its recorded timestamp. The Engine force-stages only exact paths in the sealed source/change manifests, including manifest files ignored by `.gitignore`, verifies the index tree and every blob against the Store-sealed source objects, then commits. Ignored paths outside the sealed change set are refused. The branch must be the only ref and point to that exact commit.

## 24.3 Git identity and source identity

The Git object format follows the enrolled baseline, so Git commit/tree/blob IDs may use SHA-1 or SHA-256 as Git defines them. P5's source digest remains the existing canonical SHA-256 over the complete portable path, byte-size, per-file SHA-256 and executable-mode manifest. These identities are separate. Verification checks every committed tree path and mode, retrieves each blob from Git, hashes its bytes with SHA-256 and compares them with the immutable Store objects. The candidate source digest is unchanged by adding Git metadata.

The Git candidate artifact records the original repository identity and base commit, synthetic seed and tree, private repository identity, repair branch, candidate commit and tree, candidate source/change-manifest references, Git configuration/exclude digests and a Host-measured private `.git` storage identity. Gate start/outcome/receipt, Judge dossier, P2 acceptance/retention and handoff records carry the Git-candidate reference when the enrolled policy requires it.

## 24.4 History and metadata boundary

Git commands use the enrolled executable and P5's scrubbed process environment. System/global configuration, inherited `GIT_*` redirection, optional locks, paging, automatic maintenance, hooks and checkout transformations are disabled or rejected. The repository must have one ordinary independent `.git` directory, no worktree indirection, remotes, alternates, grafts, shallow boundary, replacement refs, extra refs, unsupported configuration or hook files. Git attributes that request filters, text/EOL conversion, ident expansion or working-tree encoding are refused. Host identity checks reject redirected or unsupported Windows metadata paths.

P5 also compares the complete private object-store inventory with the objects reachable through the one repair branch. Unreachable objects are rejected, preventing a Developer or partial operation from smuggling extra Git history into the candidate. Commit and tree checks still bind source scope to the existing P5 manifest; Git metadata cannot widen source authorization.

## 24.5 Recovery and preservation

Preparation uses the durable P2 preparation intent, a private ownership marker and an immutable prepared-workspace record. The synthetic seed timestamp and pre-record marker time derive from the durable preparation intent, making recovery deterministic. Before `workspace_prepared` is journaled, recovery may finish only missing allowlisted config and empty-exclude setup in the marker-owned repository; it reuses an exact seed commit if one already exists. Conflicting settings, malformed or redirected metadata and unknown storage are preserved and refused. If a journaled `.git` directory is missing, recovery refuses before recreating it. P5 does not reset, clean, force-delete, prune, rewrite or adopt an arbitrary repository.

Commit recovery uses the durable Git commit intent. If the exact expected commit already reached the one branch, the Engine verifies its parent, identity, author and committer timestamps, tree, paths, blobs, source digest, prepared native `.git` directory identity and clean source tree, then reuses that commit. An unexpected branch tip, metadata change, extra object or source drift invalidates the candidate. The fixture injects a crash after seed creation but before the prepared event and retries the already-committed candidate intent; it does not inject a process termination at every filesystem or Store-write boundary. In particular, Engine restart recovery from a source candidate sealed before its atomic `candidate_captured` event remains unproven and blocks full P5 completion.

## 24.6 Verification and P4/P2 compatibility

The existing trusted Verification Gate remains responsible for the captured plan, protected harness, complete required checks, Host terminal/spool evidence and receipt. When Git policy is enrolled, Gate eligibility additionally checks the current exact branch and committed source before verification and after terminal verification. The receipt remains bound to the source-candidate digest and now also binds the Git-candidate reference. A moved branch cannot satisfy the captured Git subject.

Acceptance still enters the existing `judge_post_execution` path and atomic P2 Judge settlement. It captures the exact branch, commit, tree, source and metadata check time as evidence labeled `p5_acceptance`; the P2 outcome and handoff carry that same evidence instead of assigning a later settlement time as a new Git check. P6 must independently revalidate it. No Git-specific model decision type or model-selected ref, repository or policy is added. P2 link authority, Judge role, Stop precedence, retries and custody-uncertainty holds remain unchanged. `protectedSelfRepairAdmissionEnabled` remains `false`; a commit alone cannot pass the Gate or produce P2 acceptance.

## 24.7 P6 and unsupported operations

The additive handoff records the original source identity/base commit and the immutable private Git-candidate identity, commit/tree and source/change-manifest references alongside the existing receipt, Judge and P2 approval. A future P6 consumer must independently validate the stored source objects and exact commit/tree. This implementation does not apply patches to the original repository, merge, push, build a release, replace a running executable or activate a binary. Any later import or publication requires separate explicit authorization.

This policy refuses unsupported Git metadata, extra refs/remotes/objects, unsafe paths, source drift, stale P2 authority, non-clean or redirected source trees, and ambiguous recovery. It is not a hostile-code sandbox: the Developer's execution and filesystem profile remains bounded by the existing P5/Host deployment model.

## 24.8 Schema compatibility and migration

New `ProtectedSelfRepairGitRepository`, `ProtectedSelfRepairGitCommitIntent` and `ProtectedSelfRepairGitCandidate` artifacts use `schemaVersion: 1` for their new kinds. Existing source candidate, Gate receipt, acceptance, retention and handoff schemas gain optional Git-candidate references; existing version-1 source-only records remain valid to the updated reader. A strict older Engine does not accept those newly extended records, so mixed-version consumption is unsupported. Git policy is opt-in through the external enrollment; enrollments without it retain source-only behavior. No database migration is required. Runtime admission stays disabled until the entire P5 deployment and compatibility path is independently accepted.

## 24.9 Preparation evidence and limits

The native Windows fixture uses Git for Windows' actual `git.exe` and the authenticated Rust Host identity reader. It injects failure after the private seed commit but before the prepared event, then recovers the same seed and stable timestamp. It also creates the candidate commit, retries its durable commit intent, checks exact tree/source identity, force-stages an ignored but manifest-sealed source file, verifies no original source commit object or remote is present, refuses a copied `.git` directory, alternates, unreachable objects, a moved branch, source drift, an unsupported filter, missing ownership marker and missing journaled `.git` storage, and checks the original fixture's HEAD, refs, index and status are unchanged. The focused test is helper and fixture evidence; it is not a real enrolled Engine/P2/Developer/Gate/Judge E2E.

The current checkout's HEAD, enrollment and production feature flag are recorded in the date-stamped implementation-preparation report. That report distinguishes passing Git substrate proofs from unexecuted P5 lifecycle, Engine restart recovery around atomic candidate capture, P4/P2 end-to-end, P6 and publication acceptance. The resulting preparation verdict does not replace the earlier `P5 IMPLEMENTATION NOT VERIFIED` status or claim `READY FOR P6`.
