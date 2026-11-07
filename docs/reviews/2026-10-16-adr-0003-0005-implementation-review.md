# ADR-0003, ADR-0004 and ADR-0005 implementation review

Date: 2026-10-16  
Subject: local implementation of ADR-0003, ADR-0004, and ADR-0005 through Stage 3  
Verdict: **Pass. All criteria from Stages 1–3 of ADR-0003, ADR-0004, and ADR-0005 are implemented, verified by local tests, and documented.**

## Summary of checks

| Item | What was checked | Result |
| --- | --- | --- |
| Schema contracts | Seven Draft 2020-12 schemas in `docs/schemas/`: `task-assessment`, `execution-plan`, `evaluation-record`, `acceptance-record`, `context-package`, `delivery-plan`, `delivery-result`. Validated by `docs:check` and compiled by Ajv in `schemas.mjs`. | Pass |
| Storage migration | Migration `m9.sql` in `docs/storage/` creating `task_assessments`, `execution_plans`, `acceptance_records`, and `branch_deliveries`. Added to `MIGRATION_PATHS` in `store.mjs` and runtime bundler. | Pass |
| ADR-0003 logic | `taskAssessment.mjs`: source-derived risk floors (stricter wins), candidate-time diff inspection and stage escalation revision, independent reviewer confirmation on omitted stages, fail-closed policy when undeclared, and aggregate budget bounds. | Pass (`task-assessment.test.mjs`) |
| ADR-0004 logic | `contextPackage.mjs`: deterministic role-specific package construction with canonical sorting, versioned compatibility fingerprints (`fingerprint_version: 1` vs `2`), one-time invalidation of carried v1 records, `context_needed` request-and-resume, `REVIEW_INCOMPLETE` loop handling without consuming repair iterations, and criterion-to-evidence acceptance validation. | Pass (`context-contracts.test.mjs`) |
| ADR-0005 logic | `branchDelivery.mjs`: source and target ref assertions, isolated separate clone (`--reference --dissociate`), hook policy enforcement (`hooks: none`), exact candidate manifest verification, environment smoke checks, commit tree verification, expected-old-value ref update, and `READY_FOR_MERGE` delivery results. Host repository working tree and index remain completely untouched. | Pass (`branch-delivery.test.mjs`) |
| Full test suite | `npm test` and `npm run docs:check` pass without regressions. | Pass |

## Open gates

- Real-provider evaluation corpus (Stage 4) across the 7 case classes remains gated under user authorization of the ~630–2,500 invocation budget.
- Live feature branch delivery remains local and requires explicit execution authorization per target workspace.
