# Universal agent monitoring and configurable decision authority: review

Date: 2026-10-23  
Subject: the [universal agent monitoring and configurable Decision Authority proposal](2026-10-23-universal-agent-monitoring-and-decision-authority-proposal.md) (amendments A01–A13), and the pointer paragraphs added for it to [ADR-0008](../adr/0008-portable-ephemeral-lifecycle-host.md), [ADR-0009](../adr/0009-workflow-native-judge-and-exclusive-external-input.md), the [ADR index](../adr/README.md) and the [decision register](../DECISIONS.md)  
Related: [Revision 3 review](2026-10-23-progress-driven-execution-revision-3-review.md), [ADR-0008/0009 second review](2026-10-22-adr-0008-0009-second-review.md), [engine-native continuation](2026-10-22-engine-native-continuation-implementation.md), [Desktop Proof B](2026-10-23-desktop-host-proof-b.md)  
Verdict: **A careful proposal that resolves most of the Revision 3 review's findings, but not ready to adopt.**

What it gets right:

- It keeps D31, A8-I01, A9-I01 and A9-I02 in force until a separate decision replaces them.
- It makes the Decision Gate a deterministic Engine contract rather than an AI agent.
- It keeps both activation safeguards: candidate-bound review and the protected lifecycle tests.
- Its lineage-wide counters are never refunded by progress, which closes the episode-reset loophole (PDE-R01).

Two high findings remain, and both concern the guarantees the proposal is built on:

- **The trigger.** `PROGRESS_UNVERIFIED` will fire on most healthy long invocations, so it would spend the non-refundable diagnostic budget on work that is fine (UAM-R01).
- **The finiteness claim.** It holds only if "an authorized external decision" excludes an automated client holding the Owner Token (UAM-R02).

Several capabilities the proposal assumes do not exist in the current adapters, which run every provider with approvals and sandboxing bypassed (UAM-R03 and UAM-R04).

## What was checked

| Item | Result |
| --- | --- |
| No ADR status or effective contract changed | **Accurate.** ADR-0008 and ADR-0009 each gained one appended "Pending follow-up proposal (not adopted)" section (2026-10-23 10:55). The ADR index and register each gained one paragraph. No status changed, and no ID was assigned |
| `role: "judge"` is the current privileged-role contract | **Accurate.** `workflow.schema.json` has `role: {"enum": ["judge"]}`, described as "at most one agent per workflow may declare it" |
| "Current Engine recovery interrupts active attempts" | **Accurate.** `recover()` holds a `waiting_for_user` run only when no attempt is still running. A run awaiting a decision with a live CLI is not a supported state |
| The current desktop replacement terminates the provider tree | **Accurate** (Proof B) |
| ADR-0002 native supervision escalation exists and is preserved | **Accurate** (`checkEscalation` in `supervision.mjs`). §3 and FLEX-13 now preserve it explicitly |
| Provider launch flags | **Every adapter bypasses approval and sandboxing.** Codex uses `--dangerously-bypass-approvals-and-sandbox`; Claude and Antigravity use `--dangerously-skip-permissions`. All run in the workspace `cwd`. The "restricted" native configuration changes only user configuration and MCP loading (`adapters.mjs`). See UAM-R03 |
| CLI stdin | The prompt is written and stdin is then closed (`processes.mjs`: `child.stdin.end(stdin)`). A CLI that asks for input reads EOF. `classifyFailure` recognizes quota, authentication and permission text only after a failure. See UAM-R04 |
| Linked-repair workspace isolation (§9) | **Still unfixed.** `linkedRepair.mjs` compares workspace IDs only (PDE-R10) |
| ADR-0009 §11 | **Still stale.** It assigns m14 to the question tables, but m14 holds `run_links` and `lifecycle_operations`. The proposal's §11 names this reconciliation as the first step |
| Source texts of A01–A13 | **Not in the repository.** The proposal groups the IDs by section (A01–A02 in §2, and so on); no per-amendment text exists |

## Status of the Revision 3 review findings

| Finding | Status in this proposal |
| --- | --- |
| PDE-R01 episode reset defeats the allowance | **Resolved in design.** The counters are lineage-wide, are reserved before dispatch, survive restart, linked repair and run-ID changes, and are never refunded by progress. This holds only if UAM-R02 is resolved |
| PDE-R02 no time bound; no exit for a hang | **Largely resolved.** A deadline-free mode now requires a finite diagnostic route, verified provider support and a decision on D26/D30 first. §5 gives the owner-facing decision path. UAM-R01 and UAM-R05 remain |
| PDE-R03 Custody amends accepted ADR-0002 | **Resolved.** §9 and §11 name the ADR-0002 amendment |
| PDE-R04–R06 Custody topology, credential, capture path | Out of scope here; still open for the Custody PoC |
| PDE-R07 supervised escalation | **Resolved.** It is preserved in §3, §5 and FLEX-13 |
| PDE-R08 Judge outcomes and the blocker state | **Partly resolved.** A technical blocker is explicitly not a forged question. Its durable representation is still undefined (UAM-R10) |
| PDE-R09 reuse ADR-0007 contracts | **Not addressed.** ADR-0007 is listed only as related |
| PDE-R10 workspace isolation | Acknowledged as a separate, earlier code task; **still unfixed** |

## High findings

### UAM-R01 (high): `PROGRESS_UNVERIFIED` will fire on healthy long invocations and spend a budget that is never refunded

`PROGRESS_UNVERIFIED` requires a live, observable process with "no progress against saved task criteria … verified within the diagnostic window". However, the saved task criteria are normally checked only **after** an invocation ends: the checks run after the Developer returns. Inside a running invocation, the only evidence is activity:

- CLI events;
- tool calls;
- file changes.

The proposal itself, like Revision 3 P03, says activity does not prove progress. Unless an adapter can report verified progress mid-invocation, any invocation longer than the window becomes `PROGRESS_UNVERIFIED` and routes an AI review. Each review is charged to `diagnosticReviewsUsed`, which is lineage-wide and never refunded. The monitor is then either:

- inert, because the window is set above every deadline; or
- a fixed cost on every long invocation, which exhausts the counter and turns every later incident into an owner decision.

Required change:

- State what counts as **in-invocation** progress evidence for each adapter. Where none exists, the dimension is `insufficient_evidence`, and by default that must not route an AI review.
- Route an AI review only on stronger conditions: no observed activity for the window, a positive interaction or throttling signal (UAM-R04), or a policy checkpoint for a deadline-free invocation.
- Relate the diagnostic window to the applicable deadline, so a bounded invocation does not trigger a review just before its deadline would end it anyway.

Add a FLEX case: a healthy fixture invocation with steady activity and no mid-invocation verification runs past the window and does not charge `diagnosticReviewsUsed`.

### UAM-R02 (high): finiteness depends on who may grant capacity and what starts a new lineage

§4 says: "Only an authorized external decision may grant additional capacity". §5 lets the owner "authorize a specified additional diagnostic allowance". Neither says which channel counts. Under ADR-0008, the permanent Owner Token authenticates any MCP client, and ADR9-10 treats UI and MCP answers identically. This repository already ships an external AI controller workflow (`skills/deszo-control`).

An automated client holding the Owner Token can therefore keep granting allowances, or start a new top-level run for the same task, which opens a new lineage. Either way it recreates the unbounded loop the counters were meant to prevent, while the proposal still claims finite automatic decisions.

Required change:

- **Who may grant capacity.** Capacity grants should require first-party authority in the Deszo window; §5 already does this for technical blockers. Alternatively, count grants from MCP clients against a separate ceiling set by the owner, which no MCP request can raise.
- **What a lineage is.** Lineage identity must cover:
  - linked repair (`run_links`);
  - ADR-0003 plan revisions (`assessmentRunId`, `planRevisionId`, `executionRunId`);
  - restarts.
- **What starts a new lineage.** State which first-party action opens one.

This depends on ADR8-S02 (the Owner Token's scope against ADR-0001), which is still open. Resolve it together with D26/D30.

## Medium findings

### UAM-R03 (medium): diagnostic reviewers and the arbiter need a provider sandbox capability that does not exist

Every adapter launches its CLI in the workspace `cwd` with approvals and sandboxing bypassed. Two parts of the proposal assume more than that.

**Concurrent writes.** A diagnostic review (§3) runs **while** the monitored CLI is alive, in the same run, and it would use the same physical workspace. With today's flags, the reviewer can write files concurrently with the live Developer. §5's rule that blocks "source-writing effects" covers dispatches the Engine admits, not what a Full Access reviewer does on its own.

**The arbiter's information boundary.** A07 says the Engine enforces the boundary "in context construction, artifact reads, tools and indirect agent-to-agent transfer". An arbiter CLI with shell access in the project directory can read the source and logs directly. §6's caveat ("information Deszo supplies and permits") does not cover this, because today Deszo permits everything.

Require a versioned, per-provider **restricted invocation** capability, verified for the exact provider, CLI version and adapter version, as `unbounded` is. It should provide:

- an empty working directory, or a read-only snapshot;
- a read-only sandbox;
- no inherited MCP servers or extra tools.

Refuse reviewer or arbiter roles on providers that cannot be restricted. Add FLEX cases for both: an arbiter fixture fails to read a project file, and a reviewer fixture fails to write one.

### UAM-R04 (medium): `INTERACTION_REQUIRED` has no adapter basis today; add throttling and forbid answering prompts

**Interaction waits are unlikely today.** Current launches close stdin after the prompt and bypass approvals, so a CLI that asks for input reads EOF and fails. No adapter can "positively identify a CLI wait for interaction". The realistic silent states are:

- provider throttling or backoff, especially on subscription quota;
- a stalled network call;
- a genuinely long model turn.

Two changes are needed:

- **Classify throttling.** Add a provider-throttled classification, based on adapter-reported retry or backoff events and the existing `quota` patterns. A throttled invocation should not route an AI review, which would draw on the same exhausted quota. It should wait, use a deterministic recheck, or go to the owner.
- **Never answer a CLI's prompt.** State that no AI decision may answer an interactive, permission or approval prompt: no injected stdin and no granted permission. Otherwise a model could grant itself permissions through another CLI. The closed action set for `INTERACTION_REQUIRED` should be "wait", "Stop" or "owner decision".

### UAM-R05 (medium): enumerate the closed intervention actions and their authority, including Stop

§4 gives examples of what `automaticInterventionsUsed` covers: "continued observation, changed diagnostics, strategy revision and further diagnostic action". §5 grants Stop authority only to "an explicitly authorized alternative policy" at exhaustion. Three things are therefore unclear:

- Can an admitted intervention **stop a live invocation** before exhaustion? A "strategy revision" while the CLI is alive needs that, because the CLI still owns the workspace.
- If no automatic decision can ever stop a live invocation, every hang of a deadline-free invocation needs the owner. That is a legitimate choice, but it decides whether Stage 1B is practical, so it must be explicit.
- Does "continued observation" really consume an intervention?

List the closed, versioned action set. For each action, state its target, its preconditions, the authority it needs, and which counter it charges.

### UAM-R06 (medium): define who may author a privileged decision policy, and the floor the Engine enforces

Under a Decision Gate, privilege moves from a fixed role label to **policy data** in the saved workflow. External clients author that data under ADR-0001. A policy with a "quorum" of one weak reviewer would be valid as data. Specify:

- **An Engine-enforced floor** for each privileged action that no workflow configuration can lower. For activation this is §2's candidate-bound review plus the protected tests. External questions need an equivalent minimum.
- **First-party approval that shows the privileged policy** when a run is approved under ADR-0001. External-run confirmation can be switched off, so the policy needs explicit display or approval of its own.
- **Verifiable stand-ins for "actually examines"**, which the Engine cannot verify directly:
  - the reviewer's context package contained the candidate diff artifact with that digest;
  - the structured result cites that digest;
  - the result contains the required review fields.
- **Independence declared by policy**, through distinct providers, models or Contexts, consistent with ADR3-04. It must not be inferred from a participant count.

### UAM-R07 (medium): the authority transition needs an owner path and capability-conditional protected tests

§8 requires the harness and the authority contract to change together, with no window in which the old test is weakened. The harness lives outside the candidate (ADR-0008 §6.2). ADR8-S05 recommended shipping it with the Host, which self-repair cannot update (ADR8-10). Specify:

- **The update path.** The harness update is a first-party action outside self-repair.
- **What the new harness tests:**
  - it always runs the legacy designated-Judge invariants;
  - it runs the Gate invariants whenever the candidate advertises Gate support;
  - it **rejects** a candidate that accepts a workflow with a Gate policy without advertising the capability.

Without these rules, either every repair is blocked until the Gate lands, or a candidate can avoid the Gate tests by not declaring them.

### UAM-R08 (medium): state what this proposal supersedes in Revision 3, and give one accounting table

**Supersession.** Revision 3 P06 gives a finite allowance **per stagnation episode** and resets it after objective progress. This proposal makes the counters lineage-wide and never refunded. Both are live proposals, and they govern the same thing in conflicting ways. State that A05/A06 supersede P06's allowance and reset rule. That is what resolves PDE-R01. Also state how A03/A04 relate to P01 and P03 of Revision 3, which define the same three observation dimensions.

**One accounting table.** A single invocation can now be charged to several budgets:

- ADR-0003's aggregate bounds;
- ADR-0009's Judge review budget;
- the Judge turn routed by the stagnation barrier;
- the two new counters.

Add one table that says which invocation charges which counter, so no Judge turn is counted twice or not at all.

## Low findings

### UAM-R09 (low): the register row omits two of the five decisions

§1 and §11 put the Health Monitor in **accepted** ADR-0002 and the Restricted Evidence Package in **accepted** ADR-0004. Both are amendments to accepted ADRs. §11's register row lists only the D31 replacement, Stage 1B and Custody. Add the ADR-0002 observation amendment and the ADR-0004 evidence-package amendment as separate decisions.

### UAM-R10 (low): give the waiting-with-live-CLI state a concrete home

§5 correctly says this is a new state and recovery contract. Point it at the concrete gaps:

- `runs` has no pause-reason column, and m14 is taken, so the column goes in a later migration.
- `recover()` holds a run only when no attempt is running.
- A pending owner question about the live invocation should be marked **superseded** (ADR9-05) when the CLI completes first. It should then be replaced by a question based on the actual outcome, so the owner never answers a stale question.

### UAM-R11 (low): let the plan size the lineage allowances

A fixed lineage-wide allowance gives a 40-task plan the same number of automatic diagnoses as a one-task plan. Allow the ADR-0003 plan compiler to set the limits from the captured plan. They remain finite and fixed before execution.

### UAM-R12 (low): state whether non-AI managed processes are monitored

§3 covers "every managed AI role". Checks, builds and smoke tests can also hang silently and share the run's deadlines. State whether the monitor covers them, or that they keep only their own timeouts.

### UAM-R13 (low): traceability and legacy policy naming

- Preserve the individual A01–A13 texts, or give a per-ID index, so later decisions can cite exactly one amendment.
- Saved workflows have no authority-policy version field today. Name the implicit legacy policy, for example `designated-judge/1`, derived from `config.role: "judge"`, so that the captured version §7 refers to actually exists.
- Note the existing mismatch between the schema description ("at most one") and A9-I01 ("exactly one" in autonomous profiles).

## Proposed additional acceptance scenarios

| Proposed ID | Required evidence |
| --- | --- |
| FLEX-14 | A healthy, active fixture invocation that runs past the diagnostic window, with no mid-invocation verification, charges no diagnostic review (UAM-R01) |
| FLEX-15 | An Owner Token MCP client cannot grant diagnostic capacity or reset a lineage beyond the owner-set ceiling; a first-party grant can (UAM-R02) |
| FLEX-16 | An arbiter fixture cannot read a project file, and a concurrent diagnostic reviewer cannot write to the live invocation's workspace (UAM-R03) |
| FLEX-17 | A throttled provider is classified as throttled and routes no AI review to the same quota; no decision path can answer a CLI permission prompt (UAM-R04) |
| FLEX-18 | A candidate that accepts a Gate-policy workflow without advertising Gate support fails the protected harness (UAM-R07) |
| FLEX-19 | A CLI that completes while an owner question is pending supersedes that question, and the owner is shown the actual outcome (UAM-R10) |

## Recommendation

1. **Decide the authority questions first:** D26 versus D30, and the Owner Token's scope (ADR8-S01 and ADR8-S02). They determine UAM-R02, and the proposal already makes D26/D30 a prerequisite for deadline-free policy.
2. **The observation proposal** (§1 item 1) is compatible with current deadlines and can be accepted as a direction once UAM-R01 and UAM-R04 are resolved. It lands in accepted ADR-0002, so it needs its own decision (UAM-R09).
3. **The Decision Gate** needs UAM-R05, R06 and R07 before its D31 decision. The Independent Arbiter also needs the restricted invocation capability (UAM-R03).
4. **Follow the proposal's own order:** reconcile the ADR-0008/0009 text with Proof A/B, m14 and recovery behavior, and fix linked-repair workspace isolation (PDE-R10), which is still ID-only.
5. **Record supersession:** state that A05/A06 replace Revision 3 P06 (UAM-R08).

No ADR, register entry, code or test was changed by this review.
