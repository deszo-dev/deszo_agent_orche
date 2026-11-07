# ADR-0004 implementation status

Date: 2026-10-16  
Subject: [ADR-0004](0004-agent-communication-and-context-contracts.md)  
Status: Domain contracts, role packages, one-shot CLI retrieval/resume, plan-bound engine evidence resolution and candidate/branch acceptance are wired into the managed-task lifecycle and verified with fixtures. Controlled prose and real-provider comparisons remain separately gated.

## What is implemented

| Stage | Implemented | Verified by |
| --- | --- | --- |
| 1. Contracts | Migration `m9.sql` (`acceptance_records` table; `m10.sql` rebuilds `execution_plans` for plan revisions); JSON Schemas `acceptance-record.schema.json` and `context-package.schema.json`. Typed criterion-to-evidence coverage with stable status and evidence references. Schema requires non-empty criteria (`minItems: 1`). Storage persistence method `Store.recordAcceptanceRecord`. | `docs:check`, `context-contracts.test.mjs` |
| 2. Context packages | `runtime/core/contextPackage.mjs`: `buildContextPackage` deterministically constructs role-specific packages (Developer, Test Author, Code Reviewer, Test Reviewer, Analyst, Junior Analyst) with canonical sorting, inclusion reasons, and pure semantic fingerprinting via `computePackageSemanticFingerprint` (independent of attempt/instance IDs - R12). | `context-contracts.test.mjs`, `negative-probes.mjs` |
| 3. Compatibility & execution rules | `computeCompatibilityFingerprint` and `canCarryApproval`: defines `fingerprint_version: 1` (implicit legacy composition) and `fingerprint_version: 2` (explicit, binding package semantic fingerprint, style version, glossary version). Cross-version carry is refused, enforcing the one-time invalidation of pre-package approvals. `handleContextNeededRequest`: turn-and-resume context retrieval counting against step and aggregate bounds; partial retrieval preserves unresolved missing items and prevents premature resumption (R13). `handleReviewOutcomeInLoop`: within loops, `REVIEW_INCOMPLETE` retries widening within budget, then pauses for user (`waiting_for_user`) without consuming repair iterations. `evaluateAcceptanceRecord`: validates that criteria inventory cannot be empty, satisfied criteria must have typed evidence refs (R8), and unsatisfied or unverified criteria block acceptance Gates. | `context-contracts.test.mjs`, `negative-probes.mjs` |

## Review findings addressed

The [managed task contract](../MANAGED_TASKS.md) covers JSON-only envelopes, captured role-specific packages, ordinary Context expansion attempts, readable check metadata/log previews, exact additional evidence chunks and fresh independent review/acceptance bindings. Incomplete information pauses without fabricated findings or repair charges. Evidence from an obsolete plan/repair selection cannot open the current boundary. Private audit export includes the full immutable reference closure.

| Finding | Resolution |
| --- | --- |
| R1 Managed execution & storage | `Store.recordAcceptanceRecord` is invoked by the managed task after authoritative evaluation. Both candidate and verified-branch records persist through the ordinary run lifecycle. |
| R8 Empty criteria & missing evidence | `acceptance-record.schema.json` requires `minItems: 1` on `criteria`; `evaluateAcceptanceRecord` requires non-empty criteria inventory and non-empty `evidenceRefs` on any criterion marked `satisfied`. |
| Audit A2 Gate authority | The engine-owned resolver verifies stored content and matches the current task, selected evidence, plan revision, criterion, candidate and boundary. Structural validation and model assertions alone cannot accept a managed task. The [earlier audit resolution](../reviews/2026-10-16-adr-0003-0005-audit-resolution.md) records the foundation state before this wiring. |
| R12 Attempt metadata in package fingerprints | `computePackageSemanticFingerprint` extracts and hashes pure semantic inputs across initial creation and widening attempts, ensuring identical semantic expansions produce identical fingerprints regardless of step attempt IDs. |
| R13 Preserving unresolved dependencies | `handleContextNeededRequest` reports `missing` paths and returns `resumed: false` with `outcome: 'REVIEW_INCOMPLETE'` whenever requested dependencies cannot be materialized. |
| ADR4-S01 Explicit fingerprint versions | Implemented in `computeCompatibilityFingerprint`: version 1 defines legacy composition, version 2 includes package semantic fingerprint and prompt/glossary versions. |
| ADR4-R01 Turn-based context request-and-resume | Implemented in `handleContextNeededRequest`: agent emits structured `context_needed`, runtime validates and materializes content into turn directory and resumes session; counts against step attempt and aggregate bounds. |
| ADR4-R03 REVIEW_INCOMPLETE loop rules | Implemented in `handleReviewOutcomeInLoop`: retries package widening within budget, then transitions to `waiting_for_user` without consuming repair iterations. |

## Gates that remain open

- **Controlled technical prose comparison:** Versioned prompt asset evaluation comparing style efficiency against baseline with real providers requires separate execution authorization.
- **Empirical quality/efficiency:** Fixture correctness does not establish model quality, token savings or real-client timing; keep the separately authorized baseline-first experiment order.

