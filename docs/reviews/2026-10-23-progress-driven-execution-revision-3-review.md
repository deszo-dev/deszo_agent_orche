# Progress-driven execution, Revision 3: review

Date: 2026-10-23  
Subject: the [Revision 3 change report](2026-10-23-progress-driven-execution-revision-3-change-report.md), the [Revision 3 amendment proposal](2026-10-23-progress-driven-execution-amendment-revision-3-en.md) it describes, and the ADRs the proposal affects: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md), [ADR-0002](../adr/0002-execution-audit-and-supervised-control.md), [ADR-0003](../adr/0003-task-assessment-and-workflow-planning.md), [ADR-0004](../adr/0004-agent-communication-and-context-contracts.md), [ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md), [ADR-0008](../adr/0008-portable-ephemeral-lifecycle-host.md) and [ADR-0009](../adr/0009-workflow-native-judge-and-exclusive-external-input.md)  
Related evidence: [engine-native continuation](2026-10-22-engine-native-continuation-implementation.md), [Desktop Proof B](2026-10-23-desktop-host-proof-b.md), [ADR-0008/0009 second review](2026-10-22-adr-0008-0009-second-review.md)  
Verdict: **A sound and well-scoped proposal; not ready to accept as written.** The split into Stage 1A, Stage 1B and conditional Process Custody fixes the structural problem the change report describes. Engine-issued, single-use Judge grants are the right authority model. The capture claim is honest, and the repository facts are accurate apart from small imprecisions.

Two high findings block **Stage 1B**, not Stage 1A:

- The rule that starts a new stagnation episode can defeat the finite allowance (PDE-R01).
- Stage 1B can remove every time bound at once, and leave an unbounded hung invocation with no way to end except a manual Stop (PDE-R02).

The Custody candidate amends accepted ADR-0002 and proposed ADR-0008 more deeply than the impact table says (PDE-R03 to PDE-R07). Those findings belong in the PoC's scope; they do not block starting it.

## What was checked

| Item | Result |
| --- | --- |
| Change report claims "no ADR was accepted or amended" | **Accurate.** The ADR files and `DECISIONS.md` were last modified on 2026-10-22, before Revision 3. ADR-0002 and ADR-0003 were last changed on 2026-10-16 |
| `timeoutSeconds` cap of 600 seconds | **Accurate in effect, imprecise in kind.** `M1_MAXIMUM_TIMEOUT = 600` in `runtime/core/validate.mjs` is the *default* runtime capability `maximumAgentTimeoutSeconds`. It can be configured per Engine instance (`engine.mjs` constructor, `startRunner`) and is advertised in `capabilities()`. The workflow schema sets only `minimum: 5`. See PDE-R12 |
| Engine deadline enforcement | **Accurate.** `runProcess()` arms one timer for `min(timeoutSeconds, managed-task deadline − now)`, calls `killTree`, and records `aggregate_budget_exhausted` for a managed task |
| Antigravity requires a positive timeout | **Accurate.** `antigravityPrintTimeout()` throws on a non-positive value and passes `--print-timeout` with a grace period of at most 30 s, so the CLI reports its own timeout before the Engine kills the tree |
| ADR-0003 aggregate bounds | **Accurate.** §4 requires an aggregate attempt bound and an elapsed-time bound for every saved plan. ADR-0003 is Accepted (requirement D23) |
| "Proposed ADR-0009 already blocks routine dispatch on deterministic stagnation" | **This describes a design, not code.** No no-progress or stagnation detector exists in `runtime/core` or `docs/schemas`. See PDE-R09 |
| An existing rule kills a CLI "merely because no event arrived" | P01's statement is correct about **CLI** silence. However, ADR-0002's supervised control kills a healthy run's Job when the **controller** does not acknowledge (`checkEscalation` in `supervision.mjs`). See PDE-R07 |
| Desktop Proof B | **Accurate.** The Host Job contains Tauri, and Tauri's Job contains Node and the providers. Both are kill-on-close, neither allows breakaway, and replacement terminates the provider tree |
| Existing capture semantics | `runProcess()` records every byte durably as it arrives (`StreamRecorder`), and the CLI dies with its Job. P11's "confirmed durably written bytes, unknown tail is a gap" is therefore no weaker than today's guarantee |
| Linked-repair workspace isolation (P10) | `linkedRepair.mjs` compares workspace **IDs** only. Two workspace records can share one `cwd_identity`, or nest, because `workspaces` has no uniqueness on it. See PDE-R10 |
| Revision 2 and its review | **Not in the repository.** See PDE-R12 |

## What Revision 3 gets right

- **Adoption is separated.** Stage 1A keeps every hard cap. Stage 1B is an explicit amendment to accepted ADR-0003. Custody is a PoC candidate. Nothing in Stage 1A can relax a bound by implication.
- **Authority stays with the Engine.** The Engine creates `stagnationEpisodeId` and `grantId`. The Judge references them, proposes one action from a closed set, and never supplies an executable command. Consuming the grant is atomic with admitting the action.
- **Legacy timeouts are preserved.** No saved `timeoutSeconds` changes meaning. A very large number is explicitly not a substitute for no deadline. An unsupported mode is refused before launch with a typed error.
- **The failure claims are honest.** The launch guarantee is "at most one physical launch per permit", not exactly-once. Capture covers confirmed durable bytes, and an unknown tail is a visible gap. Cleanup waits for import, reconciliation, integrity and ADR-0002 retention.
- **The verified mode stays the baseline.** Proof B's termination-and-reconciliation path remains available and must keep passing (CUSTODY-11).

## High findings

### PDE-R01 (high): the episode-reset rule can defeat the finite allowance

P06 bounds the unsuccessful Judge-authorized actions *per episode*, and starts a new episode "only after objective progress against the precommitted criteria". The criteria are the Judge's own `expectedEvidence` and `preconditions`. P06 does not say who judges whether they were met, or whether a Judge-authored expectation may count as progress.

If it may, a Judge can propose an action with an easily satisfied expectation, such as "a new diagnostic artifact exists". The action "succeeds", a new episode starts, and the allowance resets, without end. In Stage 1A the existing aggregate caps still end the run, so this only wastes budget. In Stage 1B, once the owner omits the aggregate attempt and elapsed-time caps, nothing else bounds the number of episodes. LIMIT-06 and LIMIT-10 as written would not catch it.

Required change:

- Progress that **resets** an episode must be measured by the Engine against criteria taken from the saved plan, not from the proposal. Examples are the plan's required checks and acceptance criteria.
- That progress measure must be well-founded, so it can only advance a finite number of times. One example: the set of passing required criteria strictly grows. A criterion that regresses does not refund a reset.
- The Judge's `expectedEvidence` may decide only whether one action is **charged** as unsuccessful. It must never start a new episode.
- Alternatively, keep a per-run cap on episodes whenever the aggregate caps are omitted.

Add an acceptance case with an adversarial fixture Judge that always meets its own expectations. Under Stage 1B policy, it must still stop within a stated bound.

### PDE-R02 (high): Stage 1B can remove every time bound, and a hung `unbounded` invocation has no exit except Stop

Each of these four decisions is separately reasonable:

- ADR-0008's permanent Owner Token removes D26's approval period. **ADR8-S01 is still open; D26 is still a confirmed requirement.**
- ADR-0009's `workflow_native_supervision` removes external acknowledgement deadlines.
- Stage 1B may omit the aggregate elapsed-time cap.
- Stage 1B's `unbounded` mode removes the invocation deadline.

Taken together, they leave no time bound anywhere. Within one invocation, nothing then reacts to a hang:

- P01 forbids a diagnostic threshold from terminating the invocation.
- P05's barrier fires on cycle-level counters (failures, unchanged diffs, `REVISE`), and these never advance while a single CLI waits. It might be waiting on an interactive permission prompt, a login prompt or a stalled network call.

The invocation then waits until a person notices and presses Stop. P03 defines observations but no consumer for them.

Required change, in either form:

- **A floor.** Every invocation must have at least one applicable wall-clock bound: an invocation deadline, a managed-task deadline or an aggregate elapsed-time cap. Stage 1B may omit any one of them, but not all three at once.
- **A decision path.** Define what a crossed diagnostic threshold on an `unbounded` invocation produces. It needs an Engine-routed attention with a closed action set (`stop_invocation`, `continue_until_next_threshold`), charged to a finite allowance like P06. It also needs an owner-visible alert when no Judge route exists.

In either case, Stage 1B should not be decided before the user resolves D26 versus D30 (ADR8-S01). That decision sets whether the owner wants any time bound on unattended work at all.

## Medium findings

### PDE-R03 (medium): Custody amends accepted ADR-0002 §4 and proposed ADR-0008 §2 and §9.2; name the clauses

The impact table summarizes ADR-0002 as "Custody capture and independent Stop are conditional on PoC". The proposal treats changing accepted ADR-0003 as a separate decision (Stage 1B). Custody reverses these **accepted** ADR-0002 decisions with less ceremony:

- §4: "The supervisor creates and owns a per-run Job nested as a child of the application Job". Under Custody, the Job must not be under Tauri, or it dies with Tauri.
- §4: "The CLI inherits the Node-owned capture pipes unchanged, so stream capture remains in Node". Under Custody, capture moves to the Host.
- §4: the shim's suspended-create → assign → resume order, and "there is never a direct-spawn fallback". The Custody spawn path must keep both properties.
- §4 and §2: the emergency channel, and the native escalation deadline, both of which live in Tauri's supervisor (see PDE-R07).

It also contradicts two statements in proposed ADR-0008:

- §2 item 5: the Host "does **not** … invoke AI providers … or act as a general command executor".
- §9.2: "The Engine owns provider CLI processes".

List these clauses in §3 of the proposal, and record that adopting Custody requires an amendment decision on accepted ADR-0002, just as Stage 1B does for ADR-0003. Register entry 3 should say so.

### PDE-R04 (medium): Windows Job topology rules out "ownership transfer", and a Host crash needs defined semantics

**No transfer.** Windows cannot remove a process from a Job, and Proof B's Jobs deny breakaway. A CLI started under Tauri's per-run Job can therefore never be handed to Custody. Only invocations that Custody spawns itself, into a Job that does not depend on Tauri, can survive Tauri replacement. Register entry 3 ("OS-process ownership transfer") and P07 ("retain an admitted CLI") should say **Custody-launched invocations**, not transfer.

**A Host crash.** The proposal must choose one of two cases:

- If Custody Jobs are kill-on-close under the Host, as Tauri's Job is today, a Host crash kills preserved CLIs. P08 and P13 already handle the result as an unknown outcome with a tail gap.
- If they are not kill-on-close, a Host crash leaves a Full Access CLI running with no one to enforce Stop or its deadlines, which violates P12.

Recommend kill-on-close and state it. Add an acceptance case for a Host crash during a preserved invocation.

**Clock source.** Custody's deadlines should be the remaining durations the Engine computes at permit time, measured on the Host's monotonic clock. They should not be absolute wall-clock times. This follows ADR-0002 §2: "a wall-clock adjustment must not extend a lease".

### PDE-R05 (medium): specify the permit credential and what Custody can actually verify

The permit channel lets its holder start a Full Access provider CLI that outlives Tauri. That is a new privileged capability. Specify:

- **A dedicated credential.** It must be separate from the narrow lifecycle-receipt capability Proof B passes through the runner bootstrap. Bind it to the Engine generation and deliver it under ADR-0008 §4.3's handoff hygiene. Provider CLIs must never inherit it in their environment or arguments. Add it to the route/credential matrix.
- **What "rejects arbitrary commands" means.** Custody cannot see the Engine's SQLite commit, so P08's "registered committed invocation" (CUSTODY-18) is in practice "authenticated by the Engine". What Custody can enforce itself is a Host-side allowlist: provider executable identities that the Host resolves, plus an argument schema per adapter version. Commit-before-permit is an Engine-side ordering invariant, proven by the crash-injection cases.
- **The cost of being frozen.** Self-repair does not update the Host (ADR8-10). Custody's code, allowlist and spool format are therefore fixed per Host installation. A Custody defect cannot be self-repaired, and a new provider CLI or adapter version may need a manual Host update. State this, because it argues for keeping Custody minimal.

### PDE-R06 (medium): define the steady-state capture path in Custody mode

P11 makes Custody "the single OS-process and capture owner", so the Engine no longer reads the pipes. Several things that read the live stream today would then depend on spool import **during normal operation**, not only after a restart:

- the Engine's live parser and `normalized` stream;
- ADR-0002's `watch_run`;
- the live log in the UI;
- P03's activity dimension;
- the inputs to ADR-0009's stagnation detectors.

Specify three things:

- the import protocol is the steady-state path;
- its latency bound;
- its backpressure: when the Engine falls behind, the spool grows, and P11's capacity rule applies.

Otherwise an implementation will add a second, live pipe path. That path would then have to be reconciled with the spool, which P11's single-writer rule excludes.

### PDE-R07 (medium): P12 omits ADR-0002's supervised escalation and emergency Stop; P01 should name the existing rule

ADR-0002 has a third hard boundary besides Stop and deadlines. In a supervised run, the native supervisor's escalation deadline terminates the run Job when the controller does not acknowledge (`checkEscalation`). The emergency channel stops a run without the Node event loop. Under Custody, the CLI is not in the Tauri supervisor's per-run Job, so neither mechanism reaches it. Either:

- refuse Custody for `controlMode: "supervised"` runs; or
- move escalation and emergency Stop enforcement into Custody.

Add an acceptance case for whichever is chosen.

Separately, P01 should name this existing rule. It kills a healthy CLI because the controller was silent, not the CLI. P01 should classify it as a hard safety boundary, not a diagnostic threshold, so that P01 cannot be read as removing it. ADR-0009 §9 disables it only in `workflow_native_supervision` mode.

### PDE-R08 (medium): map the Judge's outcomes during an open episode onto ADR-0009's states

- **`REVISE` during an episode.** ADR-0009 routes `REVISE` to the Developer and counts K consecutive `REVISE` results as a stagnation trigger. If `REVISE` stays legal while an episode is open, it dispatches the Developer without a grant. State that inside an open episode the only Judge outcome that produces a dispatch is `AUTHORIZE_NEXT_ACTION`. Alternatively, make `REVISE` one closed-set action that consumes a grant.
- **Blocked states.** P06's "observable technical blocker" for an unavailable Judge has no defined state. Nor does the case of a Judge that answers an exhausted episode with an outcome it is not allowed to give. ADR-0009 §7 sends both to `waiting_for_user` with reason `stagnation_blocked`. Either adopt that, or add a distinct reason such as `judge_unavailable`.
- **Schema.** Both options need a run-level pause reason. `runs.pause_reason` still does not exist (ADR9-S01), and m14 now holds `run_links` and `lifecycle_operations`. ADR-0009's question tables and the pause reason therefore move to m15.
- **Composition.** State how the N and K thresholds, the Judge's review budget and the per-episode allowance (initially two) combine. For example, is a `REVISE` that a grant admitted counted toward K?

### PDE-R09 (medium): Stage 1A builds on unimplemented and unaccepted pieces; reuse ADR-0007's contracts

**Unimplemented.** "Keep ADR-0009's deterministic barrier" keeps something that does not yet exist in code. Stage 1A's scope ("implement soft diagnostic/progress checkpoints and the closed Judge action contract") must also include the N and K detectors themselves.

**Unaccepted.** "Accept the required amendments to proposed ADR-0009" requires ADR-0009 to be accepted, and ADR9-S01 to S03 are still open.

**Prior work.** ADR-0007, which ADR-0009 would supersede, already specifies much of this. Stage 1A should either reuse those contracts or say explicitly which carry over:

- separate `budget_checkpoint` and `no_progress` classifications, with a default "continue within limits" reaction;
- comparison of canonical action descriptors, without model-judged equivalence;
- denominators that are not reset across restart or linked continuation;
- shared-ledger accounting of controller and Judge calls;
- the ADR7-13 test design.

Its comparison of canonical action descriptors is also the deterministic part of P06's "renaming an unchanged hypothesis does not establish a new basis". The finite allowance, not novelty detection, is what guarantees termination (see PDE-R01).

## Low findings

### PDE-R10 (low): apply P10's canonical-path rule to the current linked-repair route now

`linkedRepair.mjs` refuses a repair only when the repair's workspace **ID** equals the parent's. Workspace registration canonicalizes paths into `cwd_identity`, but nothing prevents two IDs from sharing one identity or nesting. `one_active_run_per_workspace` is also keyed by ID. A repair can therefore run in the parent's physical directory. In today's termination mode the suspended parent has no live CLI, so the risk is the repair writing into the parent's source tree. P10 is right that "different paths to the same underlying directory do not count as isolation". Enforce it in the link route now: refuse when the canonical paths are equal or one contains the other.

### PDE-R11 (low): advertise `unbounded` support through the existing capabilities response

`capabilities()` already advertises each provider's features and `maximumAgentTimeoutSeconds`, and ADR-0001 validation is driven by those capabilities. Advertise `unbounded` support per provider, CLI version and adapter version there, so that authoring clients see it before saving. Keep the refusal before launch, because the CLI version can change between save and launch.

### PDE-R12 (low): accuracy and traceability of the change report

- Revision 2, its review and the "four agreed corrections" are not in the repository, so the change report's "Reason" column cannot be checked. Preserve them alongside the other historical reviews, or link them.
- The 600-second limit is the default runtime capability, not a schema maximum. P02's "until an explicit schema and policy revision" should read "runtime capability and policy revision". Raising the capability changes no saved workflow's `timeoutSeconds`, so legacy behavior is preserved either way.
- "Accounting retains the full ADR-0003 scope … Context and Judge turns" **extends** ADR-0003 §4, which does not list Context or Judge turns. The extension is correct and matches ADR-0007's shared ledger, but call it an extension.
- "Proposed ADR-0009 already blocks routine dispatch" should say "proposes to block", as in PDE-R09.

### PDE-R13 (low): align the Custody spool with existing Host-side durable stores

The Host already keeps an fsynced operations journal (`operations.ndjson` in `lifecycle-host`). ADR-0002 §5 defines an independent supervisor spool for emergency receipts, and the incident outbox exists in `runtime/host`. State how the Custody spool relates to them: their retention rules, ownership generations and import/ACK. That avoids three Host-side stores with three different cleanup semantics.

## Status of the related ADRs

| ADR | Status | Relevance to Revision 3 and open items |
| --- | --- | --- |
| ADR-0001 | Accepted | Invocation mode is a new schema field under v3 authoring; advertise support through capabilities (PDE-R11). The Owner Token's scope against ADR-0001's route matrix is still undefined (ADR8-S02) |
| ADR-0002 | Accepted | Stage 1A diagnostics are compatible. Custody amends §4 and the escalation/emergency design (PDE-R03, R06, R07). The capture claim matches the existing `StreamRecorder` semantics |
| ADR-0003 | Accepted | Stage 1B amends §4 and needs its own decision; PDE-R01 and PDE-R02 must be resolved first |
| ADR-0004 | Accepted | P03's observations enter Judge packages as bounded, evidence-linked fields. Compatible; they should be versioned package fields |
| ADR-0007 | Proposed; superseded only if ADR-0009 is accepted | Prior contracts for budget checkpoints and no-progress detection (PDE-R09) |
| ADR-0008 | Proposed; **text unchanged since 2026-10-22 13:03** | See the next paragraph |
| ADR-0009 | Proposed; **text unchanged since 2026-10-22** | See the paragraph after it |

**ADR-0008.** Second-review findings ADR8-S01 to S05 remain open in the text. The implementation has since moved ahead of it:

- `run_links`, the `recover()` hold and the lifecycle intent cover most of ADR8-S03 items 2–4.
- Resuming the parent **in place**, as the same run, settles ADR8-S04 for linked repair.
- Proof B makes the Host launch Tauri, which settles ADR8-R02's residual.

None of this is recorded in the ADR. The trigger (ADR8-S03 item 1) is still a first-party route, not a Judge outcome. Custody contradicts §2 item 5 and §9.2 (PDE-R03).

**ADR-0009.** ADR9-S01 is now stale twice over. §11 assigns m14 to the question tables, but m14 is `run_links` and `lifecycle_operations`, and `runs.pause_reason` still does not exist. ADR9-S02 is handled for linked repair by the `recover()` hold, but not for `external_input`, because no question table exists yet. ADR9-S03 is open. §7 needs the mapping in PDE-R08.

## Recommendation

1. **Stage 1A direction:** acceptable once PDE-R08 and PDE-R09 are addressed. Fix PDE-R01's reset rule now as well; it costs little while the aggregate caps still apply.
2. **Stage 1B:** blocked on PDE-R01, PDE-R02, and the user's decision on D26 versus D30 (ADR8-S01).
3. **Custody PoC:** may proceed as a PoC. Bring PDE-R03 to R07 into its scope, with these acceptance cases added to §6:

   | Proposed ID | Required evidence |
   | --- | --- |
   | LIMIT-13 | An adversarial Judge that always meets its own `expectedEvidence` cannot reset episodes beyond the stated bound under Stage 1B policy |
   | LIMIT-14 | An `unbounded` invocation blocked on an interactive prompt reaches the defined decision path; it does not wait until a manual Stop |
   | CUSTODY-19 | A Host crash during a preserved invocation terminates it, records an unknown outcome and a tail gap, and causes no blind retry |
   | CUSTODY-20 | The permit credential is absent from every provider CLI's environment and arguments |
   | CUSTODY-21 | Supervised escalation and emergency Stop reach a Custody-owned CLI, or Custody is refused for supervised runs |

4. **Before amending ADR-0008 and ADR-0009 under this proposal**, update their text to match what has been implemented: m14's actual contents, same-run resumption, and the Host launching Tauri. Otherwise the amendments will target stale text.
5. **Fix PDE-R10 in the current implementation.** It is small and independent of Custody.

No ADR, decision-register entry, code or test was changed by this review.
