# Rust backend migration: system design (DESZO-RUST-MIGRATION-SD)

- **Date:** 2026-11-06; remediated the same day after the independent [architecture](../../reviews/deszo-rust-migration-architecture-review.md) and [security](../../reviews/deszo-rust-migration-security-review.md) reviews (both BLOCKED on the first version).
- **Status:** design remains proposed. The isolated Variant 3 feasibility workspace was compiled and its launcher attempted on 2026-11-06, but AppContainer profile creation failed before Core started; see [15-variant3-feasibility.md](15-variant3-feasibility.md). No production code, Host, database, API or release was changed. ADR-0012 remains Proposed and nothing is committed.
- **Proposed ADR:** [ADR-0012](../../adr/0012-rust-first-backend-and-engine-lifecycle.md) (Proposed).
- **Findings:** [12-finding-register.md](12-finding-register.md) (register, architecture and security remediation matrices, re-review results).

## 1. Summary

Two Rust backend processes: a trusted **Lifecycle Host** with a bounded **Admission** component, and a repairable **Engine** under OS containment with no privileged verb and no workspace grant. The Tauri WebView UI is the only JS/TS runtime. P2 authorization and P5 acceptance stay separate mandatory stages: the Host registers Owner-started Parent Runs, launches the designated Parent Judge, issues a single-use Repair authorization consumed with the slot claim, and runs the Gate and acceptance Judge only at their enrolled workflow checkpoints. The causal check keeps the established P5 standard through an enrolled harness outside the candidate's process. Every Run executes under an Owner-authorized, Host-issued resource scope in its own principal. Builds start from a Host-issued intent; activation goes through one journal, an eligibility cutoff at the old Engine's drain acknowledgement and the G0 selector.

## 2. Documents

| Document | Content |
|---|---|
| [01-current-architecture.md](01-current-architecture.md) | Process topology, module inventory with Rust destinations, Node-specific mechanisms, evidence classification |
| [02-target-architecture.md](02-target-architecture.md) | Design rules, processes and principals, bounded Host modules, Engine responsibilities, crates, package identity, layout, recovery, Host fault limits |
| [03-trust-boundaries.md](03-trust-boundaries.md) | Enforcement, principals, capability matrix, Engine channel, threat model, platforms and fail-closed launch, limits |
| [04-self-repair.md](04-self-repair.md) | Protected P2 authorization, sealing and identity, checkpoints, causal harness, build intent and receipt, successor continuity, journal and recovery, G0 preflight |
| [05-store-and-api.md](05-store-and-api.md) | Store compatibility and imports, protected store, data preservation, protocol, gateway parity, protected questions and Stop, Owner Token and discovery |
| [06-migration-plan.md](06-migration-plan.md) | Stages and gates, compatibility matrix, coexistence, journaled cutover and downgrade |
| [07-test-strategy.md](07-test-strategy.md) | Contract map, differential verification, golden vectors, refusal tests by milestone, genuine E2E |
| [08-alternatives-and-tradeoffs.md](08-alternatives-and-tradeoffs.md) | Options A, B, C and A-S; Node versus Rust; cost |
| [09-open-decisions.md](09-open-decisions.md) | Prerequisites PR-1 to PR-10 and Owner decisions OD-1 to OD-15 |
| [10-implementation-roadmap.md](10-implementation-roadmap.md) | Milestones R0-R9 |
| [11-consistency-review.md](11-consistency-review.md) | First-version consistency pass |
| [12-finding-register.md](12-finding-register.md) | Consolidated findings, remediation matrices, re-reviews |
| [13-workflow-resource-scopes.md](13-workflow-resource-scopes.md) | Workflow-scoped Full Access |
| [14-self-repair-scope-reconsideration.md](14-self-repair-scope-reconsideration.md) | Fixed Self-Repair scope: protected Engine Core with a contained worker for repairable code (Variant 3), pending OD-12 |
| [15-variant3-feasibility.md](15-variant3-feasibility.md) | Isolated executable feasibility attempt and evidence; BLOCKED before Core launch by the current host token/environment |
| [variant3-repairability-delta-proposal.md](variant3-repairability-delta-proposal.md) | Short, conditional architecture delta for Repairability by Design; does not select OD-12 |

Diagrams: current architecture (01 §1), target (02 §2), crash and recovery (02 §8), trust boundaries (03 §3), protected pipeline (04 §1), build and receipt (04 §7.3), A → B → C (04 §8), Store ownership (05 §3), migration dependencies (06 §2), resource authority (13 §1).

## 3. Design acceptance checklist

| Criterion | Status | Where |
|---|---|---|
| All backend JavaScript responsibilities have a Rust destination | Met | 01 §2, 06 §3 |
| Tauri UI is the only final JS/TS runtime component | Met | 02 §2, 06 §6 |
| Two-process architecture evaluated; Control Process justified or rejected | Met; rejected for now with an evidence trigger | 08 §2 |
| Host's trusted responsibilities explicit and bounded | Met; sizes are a hypothesis; fault limits stated | 02 §3, 02 §10 |
| Engine remains repairable | Met | 02 §4, 04 §8 |
| P2 authorization independent of the Engine, one per incident, bound to the failed node, reproduced on the baseline before any slot is consumed | Met in design | 04 §2 |
| Gate and Judge run only at their workflow checkpoints; rejection and Gate failure terminal; complete review delivery | Met in design | 04 §5 |
| Trusted acceptance cannot be forged by the Engine | Met in design; enforcement depends on PR-1 | 04, 05 §3 |
| Host cannot be switched by an unauthorized Engine | Met in design | 03 §4, 04 §9 |
| Causal verification standard preserved | Met in design; PR-9 | 04 §6 |
| Workflow-scoped Full Access enforced per Run; scopes only for witnessed or derived Runs | Met in design; PR-2, PR-8 | 13 |
| Build-time candidate execution contained; acyclic build identity | Met in design; PR-3, PR-4 | 04 §7 |
| Successor continuity and N+1 slots | Met in design | 04 §8 |
| G0 preserved; preflight B copy-only | Met in design; PR-1 grant transition, OD-9 | 04 §10 |
| Protected Owner answers and Stop validated by the Host | Met in design | 05 §6 |
| Workflow and Run history preserved; coexistence single-writer; cutover recoverable | Met in design; PR-7a, PR-7b | 05 §2, 06 §4-5 |
| Owner Token authority kept and rotated at cutover | Met in design | 05 §7 |
| Test migration and milestone gates consistent | Met after the re-review corrections (test baseline record in M4, M6 Engine packaged in M8) | 07, 06 §2, 10 |
| Cross-platform implications explicit | Met; Windows 11 first | 03 §6 |
| Independent re-reviews complete | Met: architecture and security PASS WITH PREREQUISITES after two correction rounds | 12 §5 |

## 4. Verdict

`DESZO-RUST-MIGRATION-SD REMEDIATION VERIFIED WITH PREREQUISITES` ([12 §6](12-finding-register.md#6-verdict)): the design contracts are coherent and both independent re-reviews pass with prerequisites; PR-1 to PR-9 and OD-1 to OD-11 remain. The separate Variant 3 experiment in 15 did not establish OS containment and leaves PR-1, PR-5 and PR-10 unproven.

## 5. Self-Repair scope reconsideration

The Owner's fixed-scope decision is assessed in [14](14-self-repair-scope-reconsideration.md): `SELF-REPAIR SIMPLIFICATION PARTIALLY RECOMMENDED`. The in-process variant is blocked; the recommended Variant 3 puts repairable code in an OS-contained worker. Documents 02-13 remain the design of record (Variant 1) until the Owner decides OD-12.
