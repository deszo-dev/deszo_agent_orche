# Deszo Orchestrator Documentation

Version: 0.25
Status: confirmed requirements, verified ADR-0001, accepted ADR-0002 through ADR-0005 and ADR-0006 Windows direction, proposed complete ADR-0006, and staged contracts
Updated: 2026-10-20

Deszo is a personal Tauri/React/React Flow desktop application with an Orange-inspired node workspace. Milestones M1–M6 and the reference delivery pipeline are implemented. ADR-0001 external authoring passed its ordered acceptance campaign with the listed Windows Codex, Claude Code, and Antigravity versions.

Version 0.8 resolves [the third review](reviews/2026-10-13-third-review.md): M1's run lifecycle excludes waiting_for_user, while Context review remains independent of failure/Stop/restart outcomes. See [the current resolution](reviews/2026-10-13-third-review-resolution.md) and run [docs:check](tools/README.md). The [v0.7 response](reviews/2026-10-13-second-review-resolution.md) and [v0.6 response](reviews/2026-10-13-review-resolution.md) remain historical records.

## Start here

1. [Milestones](MILESTONES.md): usable increments, contract prerequisites, first release after M2, and proposed M1 baseline.
2. [M1 contracts](M1_CONTRACTS.md): workflow/node/port catalogue, scheduler, Context/run transitions, and HTTP/SSE API.
3. [Test pipeline](TEST_PIPELINE.md): the user's complete scenario with primitive wiring and a worked repair.
4. [Decision register](DECISIONS.md): confirmed requirements and proposal status.
5. [Product specification](PRODUCT_SPEC.md) and [architecture](ARCHITECTURE.md): UX and component/data flow.
6. [Project README](../README.md): current prototype commands and recorded checks.
7. [Architecture decision records](adr/README.md): accepted external authoring, audit/supervision, task assessment/workflow planning, agent communication/context contracts, and verified branch delivery.
8. [Authoring bridge setup](authoring/README.md): generated client configuration and local setup for Codex, Claude Code, and Antigravity.
9. [ADR-0001 implementation status](adr/0001-implementation-status.md): implemented code paths and remaining release evidence.
10. [External authoring acceptance test plan](authoring/ACCEPTANCE_TEST_PLAN.md): ordered release gates, native compatibility probes, pilot rerun, policy/cutover checks, and installed-client acceptance.
11. [Authoring acceptance report](pilots/2026-10-15-authoring-acceptance.md) and [migration note](authoring/MIGRATION_V3.md): executed G0–G5 results, supported versions/scopes, v2 retirement, and confirmation settings.
12. [Accepted ADR-0002](adr/0002-execution-audit-and-supervised-control.md): complete available execution evidence, assistant control, verified root Stop, local bugs and audit export before the shadcn/ui pilot.
13. [Accepted ADR-0003](adr/0003-task-assessment-and-workflow-planning.md): general development workflow, task assessment, explainable plan selection and comparative evaluation across task classes.
14. [Accepted ADR-0004](adr/0004-agent-communication-and-context-contracts.md): structured results, controlled technical prose, context packages, feedback on changes and measured efficiency with full available audit.
15. [Accepted ADR-0005](adr/0005-verified-feature-branch-delivery.md): exact candidate application, environment verification and verified commit evidence for a local feature branch.
16. [Managed tasks](MANAGED_TASKS.md): executable `task-planning-v1` node, reference role bindings, engine dispatch, Context/evidence retrieval, shared limits, Stop/recovery and verified branch delivery.
17. [Proposed ADR-0006](adr/0006-time-bounded-autonomy-and-application-lifecycle.md): restart-persistent approval and unattended lifecycle, with accepted Windows service/launcher direction, scoped authority/bootstrap, mutual IPC and recovery contracts.
18. [ADR-0006 implementation status](adr/0006-implementation-status.md): documentation-only scope, branch context and mandatory Windows gates; [historical first review/addendum](reviews/2026-10-20-adr-0006-review.md), [second review](reviews/2026-10-20-adr-0006-second-review.md) and separate [S01–S04 resolution](reviews/2026-10-20-adr-0006-second-review-resolution.md).

## Rule ownership and precedence

Confirmed user requirements in [DECISIONS.md](DECISIONS.md) take precedence over assistant-selected proposals. Within an authorized milestone, JSON Schema owns structural constraints and the topic document below owns semantics. A structural/semantic contradiction is a documentation defect to resolve, not permission to guess. Examples, historical reviews, and navigation indexes do not override those rules.

| Topic | Single normative home |
| --- | --- |
| Scope, release boundaries, contract readiness | [MILESTONES.md](MILESTONES.md) |
| Generic catalogue, DAG, scheduling/locks, Context, M1 commands/recovery | [M1_CONTRACTS.md](M1_CONTRACTS.md) |
| loops-v1 nodes, loop execution, M2 lifecycle and recovery, API v2, journal v2, migration 2 | [M2_CONTRACTS.md](M2_CONTRACTS.md) |
| cache-v1 and pipeline-v1 nodes, rerun planning, Context chat, Gate records, nested scopes, migration 3 | [M3_M4_CONTRACTS.md](M3_M4_CONTRACTS.md) |
| delivery-v1 Map node, task templates, Map records, verification bound, navigator, migration 4 | [M5_CONTRACTS.md](M5_CONTRACTS.md) |
| revisions-v1 scope fingerprints, selective review and task carry, generation history, Map Replay, migration 5 | [M6_CONTRACTS.md](M6_CONTRACTS.md) |
| Loop carry/decision, limits, nested scope, cache-in-loop behavior | [LOOPS.md](LOOPS.md) |
| Specification index, role views, review/Gate/Route, task capture, assembly/checks/triage | [PIPELINE_EXECUTION.md](PIPELINE_EXECUTION.md) |
| Documented map, task semantics, map/task lifecycle, progress, revisions | [IMPLEMENTATION_MAP.md](IMPLEMENTATION_MAP.md) |
| Journal event catalogue and Replay behavior | [RUN_HISTORY_AND_REPLAY.md](RUN_HISTORY_AND_REPLAY.md) |
| Filesystem/database layout, integrity/transactions, retention/export | [STORAGE.md](STORAGE.md) |
| Accepted external authoring architecture, shared MCP bridge, API migration, and integration acceptance criteria | [ADR-0001](adr/0001-external-workflow-authoring-api-and-mcp.md) |
| ADR-0001 code delivery and outstanding verification | [ADR-0001 implementation status](adr/0001-implementation-status.md) |
| ADR-0001 verification sequence and evidence requirements | [Acceptance test plan](authoring/ACCEPTANCE_TEST_PLAN.md) |
| Accepted audit/supervision/incident architecture; current runtime behavior stays unchanged until implementation | [ADR-0002](adr/0002-execution-audit-and-supervised-control.md) |
| Managed task node/configuration, compiler and run-level contracts | [Managed tasks](MANAGED_TASKS.md) |
| Proposed autonomous session and accepted Windows direction: trusted authority, scoped bootstrap, IPC, lifecycle and recovery | [ADR-0006](adr/0006-time-bounded-autonomy-and-application-lifecycle.md) |

Product specification describes interactions; architecture describes components. [Proposed baseline](PROPOSED_BASELINE.md) preserves Q01–Q22 navigation without duplicating rules. [Open questions](OPEN_QUESTIONS.md) redirects to the decision register and staged contract prerequisites.

Edit a rule in its home and update affected examples/schemas/links. Do not copy its full wording into four other documents.

## Schemas and examples

Managed task execution: [task schema](schemas/managed-task.schema.json), [reference workflow](examples/managed-task/workflow.json), [migration 11](storage/m11.sql), and [execution contract](MANAGED_TASKS.md). The engine advertises `task-planning-v1` through API v3; no existing workflow is rewritten.

M1: [application settings](schemas/application-settings.schema.json), [workflow](schemas/workflow.schema.json), [values](schemas/value.schema.json), [attempt manifests](schemas/attempt-record.schema.json), [journal](schemas/journal-event.schema.json), [API definitions](schemas/runtime-api.schema.json), [reference SQL](storage/m1.sql), and [Context-chain fixture](examples/m1-context-chain/workflow.json).

M2: the `loops-v1` part of the [workflow schema](schemas/workflow.schema.json), [journal v2](schemas/journal-event-v2.schema.json), [API v2](schemas/runtime-api-v2.schema.json), [migration 2](storage/m2.sql), [Loop decision](schemas/loop-decision.schema.json) and the [review-loop example](examples/m2-review-loop/workflow.json).

ADR-0001 authoring: [API v3 schema](schemas/runtime-api-v3.schema.json), [external-run confirmation setting](schemas/application-settings.schema.json), and [migration 6](storage/m6.sql). See [bridge setup](authoring/README.md), the [exact-version CLI neutralizer registry](authoring/mcp-neutralizers.json), and [acceptance evidence](pilots/evidence/2026-10-15-authoring-acceptance.json).

Later-stage foundations: [Loop decision](schemas/loop-decision.schema.json), [typed pipeline state](schemas/pipeline-state.schema.json), [specification section index](schemas/spec-section-index.schema.json), and [Implementation Map](schemas/implementation-map.schema.json).

The [round-recovery bundle](examples/round-recovery/SPEC.md) includes [the typed section index](examples/round-recovery/spec-index.json) and [five-task map](examples/round-recovery/implementation-map.json). It describes a hypothetical Node service, not this repository's Tauri prototype. Full M2–M6 serialized workflow/task/Gate/runner contracts remain milestone prerequisites, explicitly listed in MILESTONES.

## Status and language

Confirmed = explicit user instruction. Inherited = original architecture requirement. Proposed = selected design awaiting user acceptance. Accepted = architecture approved and recorded in the decision register; implementation remains separate. Deferred = outside the current milestone. Observed = prototype behavior. Contract specified = documentation exists, not implementation verified.

Use English for documentation, product-authored labels/descriptions/prompts, and comments. Chat stays Russian. Preserve user content and provider answers as received.

ADR-0001 is implemented and verified within its documented Windows support boundary. The real-provider pilot passed with one explicit controller retry. Confirmation now defaults to on for fresh stores and missing fields, with existing false preferences preserved. V2 saves return `410 api_upgrade_required`. The final installed bridge passed actual authoring, approval-gated execution, and result reads with all three clients; runtime/app crash recovery and Context review were also exercised. See the acceptance report for source/package hashes and remaining unsupported configurations.

## Change history

| Date | Version | Change |
| --- | --- | --- |
| 2026-10-20 | 0.25 | Refined ADR6-S01–S04: protected decision-bound user verification/key enrollment, service-owned fail-stop and last-handle gate, initial post-reboot dispatch block, retained task budgets and separate resolution history; runtime mechanisms remain unverified and complete ADR-0006 Proposed, documentation only |
| 2026-10-20 | 0.24 | Incorporated ADR6-R01–R06 and Windows trust/recovery contracts: accepted narrow D28/P29 service/launcher direction, independent authority, scoped bootstrap, protected TCB, IPC/native ownership, worker limits, compatible rollback/UI and mandatory negative tests; added status and historical review addendum, documentation only |
| 2026-10-20 | 0.23 | Added proposed ADR-0006 and D26–D27/P28 for restart-persistent time-bounded automatic operational approval, independent application lifecycle control and unattended development continuation in the ADR-0003–0005 completion branch; documentation only |
| 2026-10-16 | 0.22 | Wired managed tasks into the ordinary engine lifecycle: assessment/plans, isolated role Contexts, evidence retrieval, bounded repair, acceptance resolver, contained Git/check children, durable delivery reconciliation, UI/MCP inspection and offline reference closure; real-provider evaluation remains separate |
| 2026-10-16 | 0.21 | Implemented ADR-0003, ADR-0004, and ADR-0005 through Stage 3: task assessment, source-derived floors, candidate-time floor checks, structured results, deterministic context packages, fingerprint v2 invalidation, REVIEW_INCOMPLETE loop rules, criterion-to-evidence acceptance, isolated separate-clone branch delivery, environment smoke and verified READY_FOR_MERGE commits; migration m9 and schemas added |
| 2026-10-16 | 0.20 | Resolved review findings for ADR-0003–0005: source-derived risk floors, lifecycle linkage, evaluation cost estimate, mid-run request-and-resume context, package determinism/invalidation, REVIEW_INCOMPLETE loop rules, separate-clone delivery model, aggregate delivery budget linkage, and pilot branch base clarity; documentation only |
| 2026-10-16 | 0.19 | Refined ADR-0003/ADR-0004 with acceptance independence, deterministic selection, typed criterion evidence, incomplete review and baseline-first experiments; added D25/P27 and proposed ADR-0005 for verified local branch delivery; documentation only |
| 2026-10-16 | 0.18 | Added D23–D24 and proposed ADR-0003/ADR-0004 for general workflow planning/evaluation and agent communication/context contracts; no runtime, schema, saved-workflow or provider changes |
| 2026-10-16 | 0.17 | Accepted ADR-0002 after the second review; recorded P24 and Stage 1/2 contract requirements; no implementation or pilot execution |
| 2026-10-16 | 0.16 | Added D20–D22 and proposed ADR-0002 for execution audit, supervised control, verified root Stop, local incidents and audit bundles; no new runtime behavior or pilot execution |
| 2026-10-15 | 0.15 | Completed ADR-0001 G0–G5 for listed Windows clients/scopes, verified native isolation and the real-provider pilot, enabled default confirmation, retired v2 saves, and published migration and installed-client evidence |
| 2026-10-15 | 0.14 | Added the ADR-0001 acceptance plan for exact-version MCP isolation, the real-provider rerun, default confirmation, v2 save retirement, and all three installed authoring clients |
| 2026-10-15 | 0.13 | Began implementing accepted ADR-0001; added API v3, shared MCP bridge, guarded authoring and approval flow; client and pilot verification remain staged |
| 2026-10-15 | 0.12 | Accepted ADR-0001 after the sixth review; implementation remains separately authorized |
| 2026-10-15 | 0.11 | Added proposed ADR-0001 for external API/MCP authoring with Codex, Claude Code, and Antigravity; recorded D19 and P23 |
| 2026-10-12 | 0.1–0.2 | Workspace/Context design and proposed answers Q01–Q17 |
| 2026-10-12 | 0.3–0.4 | Per-run journal, Replay, and first-release conditional loops |
| 2026-10-12 | 0.5 | Reference delivery pipeline, map/navigator, snapshots, role separation, Q19–Q22 |
| 2026-10-13 | 0.6 | Staged delivery, M1 schemas/API/SQL, rule ownership, wired structured loops, corrected example and review resolution |
| 2026-10-13 | 0.7 | Second-review fixes, global settings/list API, batched journal, scoped Context mappings and saved validation fixtures/tools |
| 2026-10-13 | 0.10 | M2 contracts and implementation: loops-v1, recovery, Replay, API v2, journal v2, migration 2 |
| 2026-10-13 | 0.9 | M1 implemented: core-v1 engine, store, API, editor and Job Object containment |
| 2026-10-13 | 0.8 | Reserved user-wait state for M2; independent M1 run/binding outcomes and regression fixtures |
