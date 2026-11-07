# 10. Implementation roadmap

Milestones follow the stages of [06](06-migration-plan.md), revised after the independent reviews (AR-15). Each gate uses only functionality its milestone or an earlier one delivers. Evidence goes to `docs/reviews/evidence/<date>-rust-<milestone>/`, following the repository convention.

## Decision point before R0

OD-12 can only be decided after PR-1 and PR-10, which run first in R1. R0 therefore freezes the contracts common to both variants: the behavioral baseline, the protocol framing, the Store, the resource scopes (13, the same in both) and the default-deny policy of [14 §8](14-self-repair-scope-reconsideration.md#8-fixed-repair-scope-policy). The Self-Repair authority contracts are frozen at the end of R1, once OD-12 is decided.

- **Variant 3:** R3 adds the Host launch of the component worker, the Judge custody profile and the Stop and claim journals; R4 adds the Engine's worker client and the protected-role adapter copies; R6 covers claims, sealing at capture, builds before the Gate, harness launch against the built package and the activation checks; R7 keeps successor seeding and G0.
- **Variant 1:** the roadmap below applies unchanged.

## R0 (M0): Baseline, contract and authority freeze

- Deliverables: per-route wire and discovery inventory; contract map of every test file (07 §2); recorded scenarios and provider streams; canonical-JSON and Git golden vectors; profile copies of the supported origins; frozen protocol catalog, protected record kinds, resource manifest and scope records, protected question and Stop commands.
- Acceptance: every contract family has a recorded scenario; archive digests recorded; the authority documents (04, 05 §5-6, 13) reviewed with no open contradiction.

## R1 (M1): Feasibility prerequisites

- Deliverables: PR-1 to PR-9, and PR-10 when Variant 3 of 14 is pursued, evidence files and reports ([09 §1](09-open-decisions.md#1-prerequisites)).
- Acceptance: each passed, or failed with its Owner decision recorded and the design amended.

## R2 (M2-M3): Protocol and Store

- Deliverables: `deszo-protocol`; `deszo-store` with migrations, semantic imports, raw and canonical object reads, write path and `runner.lock.db` interop.
- Acceptance: golden vectors and codec refusals; projection equality on the profile copies; Node opens a Rust-written copy; a Node runner and a Rust Store process exclude each other.

## R3 (M4): Host restructuring and test packaging

- Deliverables: gateway, Shell pipe connection, direct Engine spawn, `sandbox` and `scope` modules, fail-closed launch, handle lists, typed channel with lanes, custody scoping, removal of legacy entry points; `xtask test-package` with a test-only baseline record.
- Acceptance: Host integration tests against the skeleton Engine; channel, token, grant and scope refusal tests; packaged skeleton starts, serves a forwarded request, stops and recovers under the Host.

## R4 (M5): Execution primitives

- Deliverables: sequential scheduler, Run capture and pinning, attempts under Run scopes, provider adapters for providers that passed PR-2, Stop, cancel, recovery.
- Acceptance: differential journals equal for the recorded sequential, Stop and restart scenarios.

## R5 (M6): Ordinary parity

- Deliverables: Loop, Map, Task, review Gate, context packages, branch delivery, supervision, incidents, audit, workflow Judge and Owner questions, ordinary P2, all routes, SSE, raw artifact streaming.
- Acceptance: compatibility rows of these subsystems done (06 §3); route inventory equal; UI works against the gateway.

## R6 (M7): Host Admission

- Deliverables: root enrollment, Parent registration, Parent Judge delegation, authorization and slot claims, sealing and identity, policy, Gate and acceptance checkpoints, causal harness runs, protected questions and Stop, admission journal.
- Acceptance: a fixture chain is authorized and accepted; every M7 refusal of 07 §5 passes; restart during `verifying` and `judging` yields `abandoned` and a clean retry with fresh identities.

## R7 (M8): P6 activation and genuine E2E

- Deliverables: build jobs, `BuildIntent`, reproducibility, collection, `BuildReceipt/2`, successor seeding, `eligibility_cutoff`, `switch_prepared`, Host-internal stage and switch, per-build principal grant transition, successor enrollment; test packaging applied to the M6 Engine.
- Acceptance: crash tests at `building`, `seeding`, `switch_prepared`, selector write and `switch_committed`; packaged genuine A → B → C from two Owner-started Parent incidents and the two-slot exhaustion case, with no Owner approval after enrollment and no Git push (07 §6).

## R8 (M9): Production packaging and cutover

- Deliverables: production installer and baseline record, token rotation, descriptor version 2, `deszo-mcp`, UI configuration generator, cutover journal and checkpoint, cutover inventory confirmation, optional enrollment with re-pinning (OD-11).
- Acceptance: full Rust regression on one frozen snapshot; cutover rehearsal on profile copies with restart at every step, checkpoint restore to the Node release, old bearer refused and clients rediscovered; independent read-only review of the release candidate with no open Critical or High finding.

## R9 (M10): Node backend removal

- Deliverables: removal list of 06 §6; updates to ARCHITECTURE.md, STORAGE.md and ADR statuses.
- Acceptance: no JavaScript outside the frontend tree and its build tooling; full regression passes; every retired Node test has a Rust counterpart or a recorded retirement decision.

## Gate rules for every milestone

- No milestone closes on a claim that cannot be traced to an executed test or an evidence file.
- Earlier Node results never count as evidence for Rust behavior.
- A milestone that changes a frozen contract amends the document that owns it, and the change is reviewed, before code relies on it.
