# Deszo — Architecture Amendment Proposal, Revision 3

**Subject:** Progress-driven execution, adaptive resource policies, and conditional preservation of in-flight CLI invocations  
**Status:** Proposed; not accepted or implemented  
**Affected ADRs:** ADR-0002, ADR-0003, ADR-0004, ADR-0008, ADR-0009  
**Related contracts:** ADR-0001, process containment, Engine recovery, workflow continuation, Rust Lifecycle Host  
**Basis:** Desktop Proof B, review of Revision 2, and four agreed clarifications of Engine, Judge, and Host responsibility

## 1. Architectural position and adoption boundary

Deszo should assess continuation of intelligent work from observable facts and verified progress. It must distinguish an explicit execution deadline from a diagnostic threshold, a progress checkpoint, a hard authority or resource cap, process liveness, and evidence of task progress. Duration, silence, and activity alone do not establish success, failure, or stagnation.

This proposal contains three separately adopted decisions:

1. **Stage 1A — compatible diagnostics and bounded Judge action.** Preserve all existing hard caps while adding diagnostic observations and a single-action response to stagnation.
2. **Stage 1B — resource-policy amendment.** Change accepted ADR-0003 only after a separate decision on which hard bounds an owner may explicitly omit. Existing plans retain their limits.
3. **Conditional Process Custody.** Investigate preservation of a live CLI through Engine or desktop replacement. This remains a PoC candidate until its ownership, capture, Stop, and recovery contracts pass separate proof and acceptance. The verified process-termination path remains available.

Engine remains the only workflow scheduler. Judge proposes semantic decisions within the saved graph. Host owns application lifecycle and may technically own an already admitted invocation only if the Custody extension is later accepted. Stop, integrity, process ownership, and applicable hard limits remain authoritative without a Judge turn.

## 2. Proposed amendments

### P01 — Separate diagnostic thresholds from execution deadlines

**Priority:** P0 for the contract clarification. **Targets:** ADR-0002, ADR-0003.

Production currently enforces `timeoutSeconds` and managed-task deadlines. The reviewed production path has not established a separate rule that kills a CLI merely because no event arrived. A soft inactivity threshold may initiate bounded diagnosis; it does not extend or cancel an explicit deadline.

> A diagnostic inactivity threshold MUST NOT implicitly terminate an invocation. An explicit execution deadline retains its defined enforcement semantics. Invocation duration alone MUST NOT be interpreted as proof of failure, stagnation, or lack of progress.

### P02 — Preserve legacy timeouts and version any deadline-free mode

**Priority:** P0 for compatibility; optional new mode belongs to Stage 1B. **Targets:** ADR-0001, ADR-0003.

Every existing saved workflow retains its `timeoutSeconds`, managed-task deadline, and aggregate-budget semantics after upgrade or restart. There is no silent migration from a hard timeout to a diagnostic threshold. A new or explicitly revised workflow may select a versioned invocation mode:

| Mode | Meaning |
|---|---|
| `bounded` | A fixed invocation execution deadline is enforced. This is the legacy behavior. |
| `unbounded` | This invocation has no fixed wall-clock deadline; Stop, any managed-task deadline, and other applicable hard limits remain in force. |

The diagnostic threshold is a separate setting. `unbounded` requires executable verification of the exact provider, CLI version, and adapter version. Until verified, no provider is advertised as supporting it. A provider requiring a positive process timeout remains `bounded`; the current Antigravity adapter passes a positive `--print-timeout`. An unsupported request returns a typed `invocation_timeout_mode_unsupported` refusal before launch. A very large number is not a substitute for an absent deadline. The existing 600-second runtime maximum remains effective for legacy workflows until an explicit schema and policy revision changes it.

### P03 — Observe liveness, activity, and progress separately

**Priority:** P1. **Targets:** ADR-0002, ADR-0004.

| Dimension | Possible findings |
|---|---|
| Liveness | `alive`, `exited`, `unknown` for the identified process. |
| Activity | `observed`, `not_observed`, `observation_unavailable`. |
| Progress | `verified`, `not_verified`, `insufficient_evidence` against task criteria. |

Diagnosis may use OS process identity, CLI events, stdout/stderr, descendants, native session evidence, CPU/I/O, and verified file changes. A live process can be unproductive; high CPU and file edits do not prove task progress; silence does not prove a hang. Checks must be bounded in rate and cost and do not replace ADR-0002 watchdogs or safety rules. Missing telemetry must not be relabeled as a provider failure.

### P04 — Propose a separately approved resource-policy revision

**Priority:** P0 as an acceptance decision; implementation belongs to Stage 1B. **Target:** accepted ADR-0003 §4.

ADR-0003 currently requires an aggregate attempt bound and an elapsed-time bound for each saved plan. The proposed replacement requires an explicit, versioned policy that identifies measured resources, diagnostic checkpoints, hard caps, authority to grant further work, restart and linked-repair inheritance, exhaustion behavior, and whether a particular bound may be absent.

> Every execution plan MUST declare a versioned resource policy and account for all existing classes of work. Applicable hard bounds MUST be enforced. Absence of a particular hard bound MUST be an explicitly authorized policy choice, never an omitted value or implicit unlimited permission.

The separate owner decision may allow omission of the aggregate attempt cap and aggregate elapsed-time cap. Absence of a per-invocation deadline additionally requires proven adapter support. A Loop/Repair count may become a soft checkpoint only where a new contract explicitly permits it. Authority and safety boundaries, Stop, process ownership, and integrity are never disabled by this policy.

Accounting retains the full ADR-0003 scope: assessment and discovery, preparation and formatting, implementation, tests and checks, review and triage, repair, Context and Judge turns, branch delivery, and smoke tests. Failed, interrupted, and uncertain work is counted, with unknown usage marked unknown rather than zero. Accounting survives linked repair and restart whether or not a numerical cap applies. Existing plans retain their hard limits. Stage 1A cannot implement this revision by implication.

### P05 — Treat quantitative stagnation as a Judge checkpoint

**Priority:** P0. **Targets:** ADR-0003, proposed ADR-0009 §7.

Keep ADR-0009's deterministic barrier: once a no-progress threshold fires, Engine refuses the next routine Developer/Watcher dispatch. It records the evidence and routes a permitted Judge turn. A threshold such as three identical failed cycles is a reason to review the approach, not proof that the task is unsolvable.

Judge may propose one evidence-backed next action, a changed approach or plan, runtime diagnosis, an authorized repair, `EXTERNAL_INPUT_REQUIRED`, or a justified terminal outcome. A proposed `AUTHORIZE_NEXT_ACTION` result is a new typed contract, not an existing production enum. Its action belongs to a closed, versioned set; model text is never executed as a command. Engine checks the saved graph, subject and revision, evidence, preconditions, and remaining hard caps before admitting one action.

### P06 — Make the Judge response single-use and finite

**Priority:** P0. **Target:** proposed ADR-0009.

Engine creates and durably records `stagnationEpisodeId` when the barrier fires and supplies it to Judge. A Judge proposal contains `decision`, one typed `action`, exact run/node/revision `target`, `hypothesis`, committed `evidenceRefs`, `expectedEvidence`, `preconditions`, and a reference to the Engine-issued episode. Judge does not create or replace the episode identity.

After validating the proposal, **Engine**, not the model, creates a single-use `grantId` bound to the episode, action, target, revision, preconditions, and remaining hard caps. Grant consumption and admission of exactly one corresponding attempt or transition are atomic and idempotent. Replayed delivery cannot admit a second action. An unused grant is invalidated by a changed subject or revision, Stop, revocation of its applicable authority, changed preconditions, exhaustion of a hard cap, or an optional grant expiry. Expiry of an already consumed grant does not itself kill a lawfully launched CLI.

Engine can deterministically verify evidence identity, freshness, target identity, normalized action difference, and whether expected evidence is inspectable. Judge assesses the semantic merits of the hypothesis. Renaming an unchanged hypothesis does not establish a new basis.

A versioned policy sets a **finite** allowance of unsuccessful Judge-authorized actions per stagnation episode. Two actions is an initial policy candidate, not a universal measured value. If an admitted action fails to produce progress against criteria fixed before that action, Engine blocks routine dispatch again and charges the episode. Renaming a hypothesis, role, or run, or restarting Deszo, does not reset it. A new episode begins only after objective progress against the precommitted criteria. On exhaustion Judge may request external input or return a permitted terminal decision; Engine does not schedule another automatic Judge turn or Developer retry. If Judge is unavailable, Engine records an observable technical blocker without forging a Judge question. Existing aggregate and Judge budgets continue to apply until a separately accepted Stage 1B decision.

### P07 — Keep Process Custody conditional

**Priority:** P1, PoC before adoption. **Targets:** ADR-0002, proposed ADR-0008.

The verified Windows desktop path is Host → Tauri → Node Engine → provider CLI, with application replacement terminating the managed provider tree. A proposed Rust Host-owned Custody path would retain an admitted CLI independently of Engine lifetime. It may use the existing Host core; a separate executable is not required. Custody can own and capture a process but cannot select workflow nodes, initiate new model attempts, invoke Judge, modify graphs, expand budgets, or accept development results. Unsupported platforms, adapters, and invocation types keep the verified termination/reconciliation path. Custody is not a production requirement until a separate PoC and adoption decision.

### P08 — Require a narrow, committed launch permit

**Priority:** P1, required for the Custody PoC. **Targets:** ADR-0002, proposed ADR-0008.

Engine first durably commits an invocation intent and `attemptId`. It then sends Custody an authenticated permit for that exact attempt, binding store/run/node/attempt identity, workflow revision, provider, permitted command and arguments, workspace, ownership generation, hard limits, filesystem/process scope, and a stable idempotency key. Custody rejects arbitrary commands and direct MCP, Judge, or Developer spawn requests.

Custody durably claims the permit before attempting spawn and binds any resulting OS process identity to the claim. Replaying the permit returns the original invocation state. If Engine dies after intent commit but before spawn, Custody invents no invocation; the recovered Engine reconciles the intent. If Host dies between permit claim and a provable spawn outcome, recovery checks process identity and launch state first; uncertainty blocks automatic re-spawn. The guarantee is **at most one physical launch per permit**, not unconditional exactly-once execution under every failure.

### P09 — Define eligibility to preserve a live CLI

**Priority:** P0 safety invariant if Custody is later adopted. **Targets:** ADR-0002, proposed ADR-0008.

Preservation is allowed only when the original process and Custody ownership are verified; stdout/stderr and exit outcome remain controlled; workspace ownership is held; conflicting dispatch is barred; repair writes are isolated; candidate activation leaves required binary/configuration dependencies available; the new Engine can interpret the saved invocation and result; and Stop and applicable hard limits remain enforceable without Engine. A failed condition means the invocation is not reported as safely preservable. Use the existing safe stop or an explicitly unknown outcome according to the event, without blind repetition.

### P10 — Preserve workspace ownership across Engine restart

**Priority:** P0 safety invariant if Custody is later adopted. **Targets:** ADR-0002, proposed ADR-0008.

A retained Developer CLI may still write files. A parent run becoming `interrupted` or `waiting_for_user` does not release the physical workspace. Persist ownership until the invocation is proven complete or safely released; include live Custody invocations in Engine B admission checks; forbid conflicting dispatch; and use a separate repair workspace/worktree with a defined source snapshot. Different paths to the same underlying directory do not count as isolation. The existing `one_active_run_per_workspace` SQLite rule remains useful but cannot alone guard a detached live process. Recovery must not discard process ownership merely because it changes a run state.

### P11 — Use one workflow writer and a durable Custody spool

**Priority:** P0 correctness invariant if Custody is later adopted. **Targets:** ADR-0002, proposed ADR-0008.

Custody is the single OS-process and capture owner. It writes raw evidence and a terminal receipt to a protected, Host-owned durable spool outside replaceable Deszo versions, bound to canonical installation/profile identity. Each invocation record contains an immutable launch/ownership manifest; stdout/stderr segments with stream identity, sequence, offsets, and digest; durable capture frontier and explicit gaps; exit/signal outcome; and ownership-generation history. This extends Host storage, not the workflow database. Engine remains the sole authority for run/attempt transitions in SQLite and for workflow scheduling.

The import protocol is: (1) Custody durably records bytes and identity; (2) Engine verifies invocation, generation, offsets, and digest; (3) Engine commits import and immutable audit-artifact references in its SQLite transaction; (4) only after commit does Engine acknowledge the imported sequence; (5) redelivery is idempotent and a missing range remains an explicit gap. Terminal receipts use the same commit/ACK discipline. Engine conditionally commits terminal outcome to the original `attemptId` once; duplicate exit delivery changes nothing. Durable generation fencing excludes a late commit by Engine A even if a PID is reused.

Custody may delete spool data only after complete required import is durably acknowledged, terminal outcome or uncertainty is recorded, imported artifact integrity is verified, ADR-0002 incident/audit retention is satisfied, and explicit cleanup policy allows deletion. Neither the first ACK nor process exit alone permits cleanup. An unavailable Engine, partial import, or unknown terminal result retains the data.

The preservation claim covers **confirmed durably written bytes within the defined failure model**. A Custody or OS crash between reading a pipe and durable flush can leave an unknown tail. That gap is visible; complete capture is not claimed. Spool failure, capacity exhaustion, or loss of process control enters a distinct safe Stop/reconciliation state.

### P12 — Enforce Stop and hard limits without Engine

**Priority:** P0 safety invariant if Custody is later adopted. **Targets:** ADR-0002, proposed ADR-0008.

Custody must execute authorized Stop and verify termination of the correct process tree while Engine is absent. It must enforce the saved hard invocation deadline, any applicable aggregate elapsed-time hard cap, process/resource ownership constraints, and safe behavior on capture or storage failure. Expiration does not wait for Judge. Custody cannot enlarge budgets or change timeout policy. It preserves the technical termination receipt and ownership proof so the new Engine can reconcile the outcome without inventing model success.

### P13 — Reconcile the original invocation after restart

**Priority:** P1, after a successful Custody PoC. **Targets:** ADR-0002, proposed ADR-0008.

Engine B distinguishes: **live reattachment** to the same invocation with no new provider launch; **completed reconciliation** of a spooled exit/result against the original `attemptId`; and **unknown/lost outcome** that blocks blind repetition. It imports accumulated segments through P11's commit/ACK protocol and checks saved launch manifest, adapter version, capture format, workflow revision, and workspace effects before accepting the result. A retained PID alone does not prove compatibility. An incompatible contract creates an explicit blocker, not a new model attempt.

## 3. Impact on existing ADRs

| ADR | Current guarantee | Proposed change and acceptance gate |
|---|---|---|
| ADR-0001 | Versioned authoring and execution authorization. | Retain legacy `timeoutSeconds`; introduce new invocation policy only through an explicit schema version and authorized choice. |
| ADR-0002 | Watchdogs, lossless qualified audit, containment, and Stop. | Stage 1A adds optional diagnosis separate from execution deadlines. Custody capture and independent Stop are conditional on PoC. |
| ADR-0003 §4 | Mandatory aggregate attempt and elapsed-time bounds; full accounting. | Stage 1B alone proposes a versioned policy with separately chosen hard bounds. Preserve all accounting and legacy plans. Hard-cap exhaustion still blocks execution; a soft checkpoint routes to Judge. |
| ADR-0004 | Structured results, context, and provenance. | Give Judge bounded, evidence-linked liveness, activity, and progress observations. |
| ADR-0008 §§2–3, 7–9 | Host lifecycle without model scheduling; managed replacement can terminate CLI descendants. | Only after PoC, permit narrow technical ownership of an Engine-admitted invocation and an optional preservation path. Keep the verified termination path. |
| ADR-0009 §7 | Deterministic stagnation barrier blocks routine dispatch. | Preserve the barrier; add a typed, single-use Judge proposal validated and granted by Engine, with a finite per-episode allowance. |

Changes to accepted ADR-0003 require a separate acceptance decision. ADR-0008 and ADR-0009 remain Proposed until formally accepted.

## 4. Proposed decision-register entries

This proposal does not edit `DECISIONS.md`. After separate decisions, the register should distinguish:

1. **Stage 1A — Progress diagnostics and bounded Judge action:** diagnostic thresholds differ from execution deadlines; legacy deadlines and aggregate bounds remain; Engine-issued single-use grants permit only one validated action and a finite unsuccessful-action allowance.
2. **Stage 1B — Resource-policy amendment to accepted ADR-0003:** a separately accepted versioned policy may explicitly omit particular aggregate hard bounds or, with verified adapter support, an invocation deadline. Full expenditure accounting and authority/safety rules remain.
3. **Conditional Process Custody candidate:** Host-owned spool, OS-process ownership transfer, and live CLI preservation remain candidates until PoC and separate acceptance. If accepted, narrow committed-attempt permits, workspace isolation, generation fencing, durable import/ACK, one terminal commit, and independent Stop are required. Prior Engine continuation and Desktop Proof B remain evidence for the existing termination/recovery mode.

Assign IDs and statuses from the then-current decision register. Creating this proposal does not mark any candidate Accepted or silently rewrite historical decisions.

## 5. Acceptance and implementation sequence

### Stage 1A — Compatible diagnosis and bounded Judge action

Scope: P01–P03 and P05–P06. Inspect current schemas and code; preserve legacy invocation, managed-task, and aggregate hard limits; accept the required amendments to proposed ADR-0009; then implement soft diagnostic/progress checkpoints and the closed Judge action contract. Prove Engine-issued identities, atomic single-use admission, hard-cap enforcement, and finite stagnation episodes. This stage does not change process ownership or enable `unbounded`.

### Stage 1B — Separate resource-policy decision

Scope: P04 and P02's new `unbounded` mode. Start only after explicit acceptance of the ADR-0003 amendment, the dimensions allowed without a hard cap, and a new schema/policy version. Preserve old plans, test provider/CLI/adapter capability before launch, keep all expenditure accounting, and refuse unsupported modes. Stage 1B need not precede the conditional Custody PoC.

### Stage 2 — Narrow Process Custody PoC

Scope: P07–P12. Use a Rust-owned deterministic fixture CLI and real Windows process ownership. Prove committed-attempt permits, idempotent spawn, Host-owned durable spool, uninterrupted capture while Engine is absent, import/ACK, verified Stop, retained workspace ownership, generation fencing, and one terminal commit. Inject failures after intent commit before spawn; after spawn before acknowledgement; after terminal commit before acknowledgement; and during Engine absence at Stop or hard deadline. Test arbitrary-spawn refusal, retention, and visible incomplete capture. The existing Desktop Proof B must still pass for the current mode.

### Stage 3 — Engine and Host recovery compatibility

Scope: P13. Run a real Engine A → Engine B transition; verify the original CLI PID, fencing of Engine A, no duplicate provider invocation, compatible import, and at-most-once acceptance of a result that completed while Engine was absent. Incompatible contracts produce a blocker.

### Stage 4 — Separate desktop Proof C

Only after Stages 2–3 pass, use two real Tauri builds and a deterministic CLI. Prove Host → Tauri A/Engine A → Tauri B/Engine B while the original Custody-owned CLI remains alive; preserve confirmed output and exit status; reattach the original invocation; commit its result once; launch no duplicate; and continue the workflow safely. The optional mode must not weaken existing Stop and crash containment.

## 6. Proposed acceptance criteria

| ID | Required evidence |
|---|---|
| LIMIT-01 | An old workflow retains its original `timeoutSeconds` behavior. |
| LIMIT-02 | A soft diagnostic threshold does not terminate a healthy CLI. |
| LIMIT-03 | An explicit hard deadline is enforced. |
| LIMIT-04 | A soft progress checkpoint reaches the designated Judge. |
| LIMIT-05 | Judge cannot override an applicable hard cap. |
| LIMIT-06 | Repeating an unchanged continuation proposal cannot create an infinite dispatch loop. |
| LIMIT-07 | Stage 1A retains existing aggregate bounds and the full ADR-0003 accounting scope. |
| LIMIT-08 | Engine creates `grantId` and `stagnationEpisodeId`; Judge cannot replace them or supply an executable arbitrary command. |
| LIMIT-09 | A Judge grant admits one closed-set action and is consumed atomically with that transition. |
| LIMIT-10 | A finite unsuccessful-action allowance survives restart/run renaming and resets only on predefined objective progress. |
| LIMIT-11 | An unsupported provider/CLI/adapter combination rejects `unbounded` before launch, without a fake large timeout. |
| LIMIT-12 | Managed-task deadlines and Stop continue to apply regardless of invocation mode. |
| CUSTODY-01 | A live CLI survives a real Engine-process restart in the conditional mode. |
| CUSTODY-02 | Confirmed durable output continues to be captured while Engine is unavailable; gaps are explicit. |
| CUSTODY-03 | Engine B attaches to the original invocation. |
| CUSTODY-04 | Engine A cannot write after generation handoff. |
| CUSTODY-05 | Terminal outcome commits once to the original attempt. |
| CUSTODY-06 | Workspace ownership blocks conflicting dispatch. |
| CUSTODY-07 | Repair and a retained Developer have no conflicting write scope. |
| CUSTODY-08 | Authorized Stop works without Engine. |
| CUSTODY-09 | Applicable hard deadlines work without Engine. |
| CUSTODY-10 | Unknown outcome never causes blind provider retry. |
| CUSTODY-11 | The existing Desktop Proof B still passes in its termination mode. |
| CUSTODY-12 | Two real Tauri builds pass the preservation scenario. |
| CUSTODY-13 | Intent/`attemptId` commit precedes permit; permit replay causes at most one physical launch. |
| CUSTODY-14 | Pre-spawn and post-spawn/pre-ACK crashes reconcile without invented or duplicate invocations. |
| CUSTODY-15 | The spool records confirmed durable bytes, offsets, digests, terminal receipt, and any unknown tail. |
| CUSTODY-16 | ACK follows durable import commit; segment/receipt redelivery is idempotent. |
| CUSTODY-17 | Cleanup waits for artifact integrity, outcome reconciliation, and ADR-0002 retention obligations. |
| CUSTODY-18 | Arbitrary Host spawn without a registered committed invocation is rejected. |

## 7. Adoption boundary

The distinction between diagnosis and deadlines, legacy timeout compatibility, bounded Judge review of stagnation, and separation of soft checkpoints from hard caps may be accepted as the Stage 1A direction. Its concrete ADR amendments and implementation still require their normal acceptance and authorization.

Removing mandatory aggregate bounds or allowing an invocation without a fixed deadline requires the separate Stage 1B product and ADR-0003 decision. Neither follows automatically from Stage 1A.

Process Custody, OS ownership transfer, and preservation of CLI across Tauri replacement are not yet baseline requirements. A passing PoC alone does not accept ADR-0008/0009 or claim support for every platform, adapter, or invocation type.

## 8. Conclusion

Stage 1A adds progress-oriented diagnosis and a tightly scoped, single-use Judge response while retaining existing hard bounds. Stage 1B may revise particular bounds only through an explicitly accepted, versioned ADR-0003 policy and verified provider capability. Conditional Process Custody requires committed-attempt launch permits, isolated workspaces, independent enforcement, durable capture/import, generation fencing, and one terminal outcome commit before it can preserve a CLI across Deszo replacement.

Until those separate proofs and decisions, the existing Engine/Host/Desktop Proof B termination and recovery mode remains the verified behavior.
