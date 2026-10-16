# ADR-0003 implementation status

Date: 2026-10-16  
Subject: [ADR-0003](0003-task-assessment-and-workflow-planning.md)  
Status: Domain contracts and bounded managed-task engine dispatch are implemented and verified with deterministic CLI fixtures, real check subprocesses and isolated Git repositories. Stage 4 real-provider evaluation remains separately gated. Automatic parallel Map decomposition is not part of this compiler increment.

## What is implemented

| Stage | Implemented | Verified by |
| --- | --- | --- |
| 1. Contracts | Migration `m9.sql` (`task_assessments` and `execution_plans` tables; `m10.sql` keys `execution_plans` by `(id, plan_revision_id)` for stores that applied the earlier m9); JSON Schemas `task-assessment.schema.json`, `execution-plan.schema.json`, and `evaluation-record.schema.json`. Durable identities `assessmentRunId`, `planRevisionId`, `executionRunId`. Storage persistence methods `Store.recordTaskAssessment` and `Store.recordExecutionPlan`. | `docs:check`, `task-assessment.test.mjs` |
| 2. Plan selection & risk floors | `runtime/core/taskAssessment.mjs`: `deriveSourceFacts` extracts critical paths, public contracts, and fan-out metrics from captured source inputs against project policy; undeclared policy fails closed to full reference stages. `selectExecutionPlan` deterministically derives risk floors and enforces stricter wins over Analyst assessment; requires explicit independent reviewer confirmation for omitting any reference stages. Strict role bindings required (no invented models - R9). Distinct reviewer roles enforced by serialized identity (R10). Canonical fingerprint includes requirements and aggregate bounds (R11). High uncertainty or unverified verifiability elevates floor to at least modular (R14). | `task-assessment.test.mjs`, `negative-probes.mjs` |
| 3. Candidate diff floors & budget | Assembly-time mandatory floor check `evaluateCandidateFloors`: compares actual candidate diff against plan floors before delivery review; if candidate touches critical paths or public contracts not in compact plan, triggers automatic plan revision and stage escalation. `chargeAggregateBounds`: tracks attempts and elapsed seconds across preparation and execution; halts on exhaustion without silent approval. | `task-assessment.test.mjs` |

## Review findings addressed

The [managed task contract](../MANAGED_TASKS.md) describes the completed execution integration in `taskRuntime.mjs` and `taskProcesses.mjs`: ordinary scoped attempts, private role Contexts, bounded discovery, captured workflow/template binding, mandatory actual-diff escalation, explicit role efforts, check triage/repair, independent acceptance policy and shared attempt/deadline accounting. Migration [m11](../storage/m11.sql) stores durable task state, per-process work, plan-bound evidence and delivery intent. [Engine tests](../../runtime/tests/managed-task.test.mjs) exercise these paths without provider quota.

| Finding | Resolution |
| --- | --- |
| R1 Managed execution & storage | Store persistence and the managed `task` node are wired through the existing scheduler, native launcher, journal, Stop and recovery. |
| R9 Explicit role bindings | Omitting role bindings produces a validation diagnostic error rather than substituting invented models or providers. |
| R10 Reviewer separation | Code reviewer and test reviewer must have distinct serialized role identifiers; identical roles on distinct objects are rejected. |
| R11 Plan fingerprint closure | Plan fingerprint hashes canonical closure of requirements, acceptance criteria, boundaries, role bindings, and aggregate bounds. |
| R14 Uncertainty & verifiability | High uncertainty, unverified verifiability, or unresolved questions elevate floor to at least modular and require full reference stages. |
| ADR3-S01 Candidate-time floor check | Implemented in `evaluateCandidateFloors`: candidate diff is inspected before delivery review; exceeding plan floors triggers workflow escalation revision. |
| ADR3-S02 Project policy critical areas | Implemented in `deriveSourceFacts`: uses configurable `projectPolicy.criticalAreas` and fails closed to full reference stages if undeclared. |
| ADR3-S03 Quota planning estimate | Documented in ADR-0003 §5: ~63 runs across 7 classes, 10–40 invocations per run, representing ~630–2,500 managed provider invocations with priority sequence. |

## Gates that remain open

- **Stage 4 live evaluation:** Running the comparative corpus with real providers and subscription quota requires explicit user authorization of the ~630–2,500 invocation budget.
- **Automatic decomposition/optimization:** The current fixed compiler executes a source bundle sequentially; existing authored Implementation Maps remain supported. No automatic parallel decomposition or efficiency claim is made for the seven-class corpus.

