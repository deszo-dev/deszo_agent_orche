# Deszo — Universal Agent Monitoring and Configurable Decision Authority

**Status:** Proposed architecture amendment; neither accepted nor implemented  
**Date:** 2026-10-23  
**Targets:** ADR-0001–0004, proposed ADR-0008 and ADR-0009  
**Related:** ADR-0001, proposed ADR-0007, [progress-driven execution Revision 3](2026-10-23-progress-driven-execution-amendment-revision-3-en.md)

This proposal consolidates amendments A01–A13. It describes a future contract, not current runtime behavior. Accepted ADR-0002/0003/0004 remain effective. D31, A8-I01, A9-I01 and A9-I02 retain their recorded meaning until a separate architecture decision explicitly replaces the designated-Judge authority model. Existing invocation deadlines, managed-task deadlines, aggregate bounds, supervision escalation, Stop and workspace protections remain in force. The unresolved D26/D30 authority conflict must be decided before adopting a new unattended or deadline-free policy.

## 1. Decision and adoption boundaries

The following decisions must remain separate:

1. **Compatible observation proposal:** A role-independent, deterministic health monitor may classify invocation evidence without changing an execution deadline or a hard safety boundary.
2. **Decision Authority proposal:** Replacing D31's single designated Judge with a configurable Decision Gate requires an explicit architecture decision and coordinated changes to proposed ADR-0008/0009, workflow schema, Engine validation and protected lifecycle tests. Documentation alone does not grant the Gate authority.
3. **Resource-policy proposal:** An invocation without a fixed deadline remains a separate Stage 1B decision affecting accepted ADR-0003. Verified provider support, owner authority and a finite diagnostic decision path are prerequisites. Existing saved workflows retain their limits.
4. **Process Custody proposal:** Preserving a CLI across Engine or Tauri replacement remains conditional on a separate PoC and adoption decision. Health monitoring does not itself transfer process ownership or make a live invocation survive restart.

Engine remains the only workflow scheduler and the only authority for run and attempt transitions. A Decision Gate, if adopted, may be an optional workflow graph node; the deterministic Engine-enforced admission check for every privileged action is mandatory regardless of graph shape. The Gate is not an AI agent, a Host scheduler or an executable command endpoint. Host and any future Custody may perform authorized technical supervision but cannot initiate AI diagnosis or grant themselves workflow authority.

## 2. A01–A02 — Replace Judge authority only by decision; preserve lifecycle proof

The proposed replacement for the physical single-Judge rule is: **each privileged action must have exactly one verifiable result of the authorized, versioned decision process captured in the saved workflow**. The process may include one Judge, multiple experts, sequential review, a quorum, a veto or a final arbiter. A worker result alone cannot issue an external question or lifecycle proposal. Engine must validate the exact policy, participants, result identities, subject and graph revision, candidate identity, authority, budgets and replay state before admitting the action.

An explicit decision must say how this rule replaces D31, A8-I01, A9-I01 and A9-I02. Until then, only the currently designated Judge may propose privileged lifecycle and semantic external-input actions under the current proposed ADR-0008/0009 contracts. The new model does not silently rewrite saved single-Judge workflows.

For candidate activation, the decision process must retain **both** independent ADR-0008 safeguards:

- An authorized project-aware reviewer actually examines the candidate diff, architecture changes and lifecycle-authority implications. The review result is bound to the exact candidate identity and digest.
- The fixed, protected lifecycle contract suite outside the candidate's editable source runs against that same candidate artifact. Its result and provenance are bound to the same digest.

Decision Gate checks these results and the selected policy. A quorum, an independent arbiter's approval or the Gate alone does not replace substantive review or protected tests. Failed, missing, stale or mismatched evidence refuses activation.

## 3. A03–A04 — Role-independent health and finite diagnostic routing

One deterministic Invocation Health Monitor applies to every managed AI role, including a Judge invocation. It distinguishes exact process liveness, observation-channel health, observed activity and independently verified task progress. Unknown telemetry stays unknown. Silence is neither proof of a hang nor a reason to kill a CLI. A healthy, active CLI may still lack verified task progress.

The proposed diagnostic classifications are:

| Classification | Required evidence | Response |
| --- | --- | --- |
| `OBSERVATION_UNRESOLVED` | The process or observation channel cannot be classified reliably | Bounded technical recheck, then one incident and policy-routed escalation |
| `PROGRESS_UNVERIFIED` | Process is alive and observable, but no progress against saved task criteria is verified within the diagnostic window | Analyze causes and route a bounded review; do not infer a hang or automatically Stop |
| `INTERACTION_REQUIRED` | A supported adapter positively identifies a CLI wait for interaction | Immediately route through the supported decision path; silence alone cannot establish this classification |

The standard unresolved/progress diagnostic path performs at most two deterministic checks per incident, separated by a configured interval independent of `timeoutSeconds`. A positively identified interaction wait need not wait for the second check. Repeated delivery of the same incident is idempotent. The workflow may route one authorized diagnostic AI review, a finite composed review or an authorized external decision. A malfunctioning Judge is not required to diagnose itself; unavailable AI routes produce a visible technical blocker. A Host never invokes an AI agent while Engine is unavailable.

The diagnostic threshold is soft. It does not cancel an applicable invocation deadline, managed-task deadline, aggregate cap, ADR-0002 native supervision escalation or authorized Stop. Before any deadline-free invocation mode is accepted, its exact provider/CLI/adapter combination and interaction behavior must be verified, and this finite diagnostic route must be implementable for it.

## 4. A05–A06 and A11 — Monotonic, durable review and intervention budgets

A captured, versioned policy sets separate **finite** root-lineage limits for:

| Counter | Charged on admission of |
| --- | --- |
| `diagnosticReviewsUsed` | Each AI invocation for diagnosis, including each member of a composed Judge process |
| `automaticInterventionsUsed` | Each autonomous action authorized after diagnostic escalation, including continued observation, changed diagnostics, strategy revision and further diagnostic action |

Engine durably reserves review capacity before dispatch. It creates an Engine-issued, single-use `grantId` for a validated intervention and atomically consumes it with the exact dispatch intent or state transition. A grant is bound to the root lineage, incident or stagnation episode, exact target and graph revision, closed typed action, preconditions, applicable authority and remaining hard limits. Model text is never an executable command. Replayed incidents, reviews and grants neither launch additional work nor charge a counter twice. An uncertain outcome is reconciled before any capacity can be returned.

Both counters survive Engine or desktop restart, new incidents, linked Repair and run-ID changes within the lineage. Agent-declared success, renamed hypotheses and superficial action-label changes do not reset them. Verified task progress is measured against criteria saved before the action; it may close an incident and resume ordinary workflow, but it does not refund the lineage-wide counters. Only an authorized external decision may grant additional capacity. Once either automatic allowance is exhausted, no further autonomous diagnostic review or intervention is admitted.

This policy bounds **automatic decisions**, not necessarily the duration of an already admitted invocation. Aggregate accounting and hard bounds under accepted ADR-0003 remain effective unless separately amended.

## 5. A10 — Live invocation while an external decision is pending

After automatic escalation is exhausted, the proposed default is to keep the original CLI alive **only while** its execution policy, applicable hard limits, containment, workspace ownership, capture health and Stop capability remain enforceable. Deterministic observation continues without further AI calls. Engine blocks new conflicting dispatch, repair, lifecycle or source-writing effects and presents an owner-visible decision path. An explicitly authorized alternative policy may Stop the invocation on escalation exhaustion; a diagnostic threshold by itself never supplies that authority.

The owner may choose to keep waiting, Stop, authorize a specified additional diagnostic allowance or select a permitted recovery action. A new allowance is durably bound to the lineage and authority decision. Any recovery that could write the live invocation's physical source scope remains blocked until ownership is safely released or verified isolation exists. A CLI completion is recorded against the original attempt; the incident and each pending question are reconsidered from the actual outcome. Only a question whose predicate no longer applies becomes `superseded` (for example, Stop or keep waiting); a retry or recovery question may remain relevant or be revised with history. Terminal commit and question transition are coordinated, and no blocked dispatch resumes or CLI relaunches merely because the process exited.

The run's *external-decision-pending* state and the invocation's *still-active* state must be independently represented. Waiting for a person does not automatically terminate, duplicate or release the invocation's process/workspace ownership. This is a new state and recovery contract; current Engine recovery interrupts active attempts and cannot be cited as evidence that it already works. Live preservation across Engine or desktop replacement may be claimed only after separate Custody adoption; otherwise the current termination-and-reconciliation path applies.

When the authorized semantic decision route exists, Engine may create a versioned external question through that route. If its Judge or Decision Gate is unavailable, its allowance is exhausted, or D31's still-effective boundary does not permit it, Engine records a **technical blocker** and exposes first-party resolution without fabricating `EXTERNAL_INPUT_REQUIRED` or a Judge decision. No AI polling occurs while awaiting the external decision. Applicable hard Stop, deadlines and native supervision continue independently.

## 6. A07 — Restricted Evidence Package for an independent arbiter

An Independent Arbiter may be guaranteed a restricted Deszo-controlled information path only after the required runtime capability exists. The package is built by Engine from an allowlist of typed, provenance-checked facts such as check ID/status, verified artifact digest, formal review status, provenance reference, policy version and authority status. It excludes project files, source or diff text, raw stdout/stderr, arbitrary `reason` fields and free-form content from other agents unless a separately reviewed schema explicitly permits them. A model's assertion that a test passed is not a trusted test result.

Engine enforces the information boundary in context construction, artifact reads, tools and indirect agent-to-agent transfer. The arbiter may return `INSUFFICIENT_EVIDENCE`. The guarantee concerns information Deszo supplies and permits; it does not claim absolute independence from every possible external information source.

## 7. A08–A09 and A13 — Generic roles, explicit capabilities, legacy compatibility

New Agent roles using capabilities already supported by the Agent Runtime may be composed through workflow configuration without changing Engine code. A new privileged effect, protected context boundary, result type or authorization rule requires a separately versioned Engine/API/schema contract. For example, an ordinary architecture reviewer may be a configuration of supported capabilities; an Independent Arbiter with the guaranteed Restricted Evidence Package and a lifecycle-authorizing Decision Gate are **new capabilities**, not mere role labels or prompt instructions.

Existing saved single-designated-Judge workflows retain their captured authority-policy version and behavior. Migration to a Decision Gate policy requires an explicit compatible workflow revision and authorization; missing fields do not mean new authority. Recovery and replay interpret the captured version, and legacy and new policies have separate acceptance fixtures. Current schema's special `role: "judge"` remains the effective privileged-role contract until a separately accepted versioned extension replaces it.

## 8. A12 — Protected lifecycle tests at the authority transition

The protected harness and the versioned authority contract must change together. Before the separate D31 replacement decision is accepted, the existing designated-Judge checks remain in force. A new Gate policy must be tested against the exact candidate artifact and policy version, at least for:

- Valid Gate result with all mandatory review, protected-test, authority and budget evidence.
- Direct worker/Host/MCP bypass, forged participant or review result, stale graph revision and prompt-only privilege escalation.
- Review or protected-test receipt for another candidate digest; missing review; failed tests.
- Replayed permission, duplicate delivery and revoked or exhausted authority.
- Legacy single-Judge workflow under its captured policy, without silent reinterpretation.

No activation window may exist in which the old protected test is weakened before the new Gate is enforced. A result from the candidate's own editable test harness cannot stand in for the protected suite.

## 9. Conditional Custody and implementation boundaries

Health monitoring, Decision Gate and Process Custody are different responsibilities. Custody, if separately accepted, may own only an Engine-admitted invocation, capture its streams and enforce Stop and hard limits while Engine is unavailable. It cannot schedule workflow nodes, call AI agents or decide a repair. The verified current desktop replacement terminates the provider tree; no live CLI preservation is claimed here. Custody would require a separate amendment to accepted ADR-0002's process ownership/capture contract as well as proposed ADR-0008, plus the independent Windows PoC and acceptance decision described by Revision 3.

The current linked-Repair workspace isolation issue is a separate implementation task. Neither a distinct workspace ID nor a run pause proves nonoverlapping physical source ownership. This proposal does not implement its fix, Custody, monitoring, Decision Gate, schema changes or migration changes.

## 10. Proposed acceptance scenarios

| ID | Future verification requirement |
| --- | --- |
| FLEX-01 | A long-running invocation of any role crosses a soft diagnostic threshold without an implicit Stop or extension of a hard deadline. |
| FLEX-02 | Two unknown checks produce one idempotent `OBSERVATION_UNRESOLVED` incident; a verified adapter interaction signal routes immediately. |
| FLEX-03 | An alive, observable CLI with no verified progress routes diagnosis without being classified as dead or automatically stopped. |
| FLEX-04 | Every diagnostic AI invocation, including each member of a composed review, is charged once to the root-lineage review limit. |
| FLEX-05 | Repeated incidents, renamed hypotheses, superficial results, linked Repair and restart cannot reset review or intervention limits. |
| FLEX-06 | After exhaustion, the live CLI remains observable and Stoppable under the default policy; no new AI review or conflicting write is admitted. |
| FLEX-07 | CLI completion while an external decision is pending commits the original outcome once and does not bypass the dispatch barrier. |
| FLEX-08 | An unavailable Judge/Gate produces a visible technical blocker, not a forged semantic question. |
| FLEX-09 | A Judge invocation is monitored without requiring that Judge to review its own health. Host failure does not initiate AI diagnosis. |
| FLEX-10 | An independent arbiter receives only allowlisted, provenance-verified fields through Deszo-controlled channels; insufficient evidence is an allowed result. |
| FLEX-11 | A new ordinary role uses supported capabilities without Engine change; a new protected boundary or privileged result is refused until its versioned contract exists. |
| FLEX-12 | Protected tests reject Gate bypass, forged/mismatched/stale review or test receipts, replay and prompt-based privilege escalation while preserving the captured legacy single-Judge policy. |
| FLEX-13 | Applicable timeout, aggregate resource, supervision escalation, workspace and Stop rules remain effective across diagnostic and external-wait states. |

These are **future acceptance requirements**, not reports that the current runtime passes. Deterministic fixture providers are appropriate for contract tests; real provider support and live desktop/Custody behavior require separate evidence.

## 11. Documentation ownership and next decisions

| Home | Proposed contract |
| --- | --- |
| ADR-0002 | Invocation health classification, bounded deterministic checks, independent safety and supervision boundaries. |
| ADR-0003 | Existing aggregate bounds; separate future resource-policy decision and durable lineage accounting. |
| ADR-0004 | Structured diagnostic evidence and Restricted Evidence Package. |
| ADR-0008 | Lifecycle authority, candidate-bound substantive review and protected tests; conditional Custody boundary. |
| ADR-0009 | Versioned Decision Authority, closed typed actions, finite review/intervention budgets and external-decision states. |
| ADR-0001 | Capability discovery and authorization compatibility if new schema/API fields are adopted. |
| Decision register | Separate unresolved D31 replacement, ADR-0003 Stage 1B and ADR-0002 Custody amendment; no acceptance inferred from this document. |

Before implementation, first reconcile ADR-0008/0009's stale descriptions with the verified Proof A/B, current m14 schema and recovery behavior. Decide the D31 authority change explicitly, then update the protected harness and versioned schema together. The linked-Repair physical workspace isolation fix remains a separate, earlier code task. Custody remains a later independent PoC. The current ADR and runtime status is not changed by publishing this proposal.
