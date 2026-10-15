# M1–M6 review closure

Date: 2026-10-13  
Reviewed: [follow-up resolution](2026-10-13-m1-m6-resolution-followup-review-resolution.md)  
Outcome: **F1, F2 and F3 are verified as corrected. No new blocking finding was identified in the reviewed changes.**

The previous implementation review and follow-up remain historical records. Their original blocking findings can now be closed within the source-review and fixture-validation scope. This does not certify the untested real-provider, packaged-desktop or load scenarios below.

## Independent verification

| Check | Observed result |
| --- | --- |
| `npm.cmd test` | 330 passed; 0 failed, cancelled, skipped or todo; approximately 178 seconds |
| `npm.cmd run docs:check` before this note | Passed: 15 schemas, 141 positive schema cases, 82 negative schema cases, 39 negative semantic cases, 402 local links and 67 SQL cases |
| `npm.cmd run build` | TypeScript/Vite build passed; the 651.28 KB main chunk still produces the existing optimization warning |
| `npm.cmd run runtime:bundle` | Passed |
| `cargo check --locked` | Passed |
| `cargo test --locked` | Passed: one Windows Job containment test |

No real provider was called. Production source and existing review/probe artifacts were not edited. The earlier probes were assessed through the new regression tests adapted from those scenarios, preserving the historical recorded results.

## Findings closed

### F1 — approval reuse with changed shared Context history

[Engine.reviewerFingerprint](../../runtime/core/engine.mjs) now walks After dependencies as well as data dependencies. It also checks other Agents and Map roles that reference the reviewer's Context. Shared or otherwise unprovable history yields a null fingerprint and requires a live review. Fingerprint version 3 invalidates approvals recorded under the previous definition.

The F1 regression in [followup.test.mjs](../../runtime/tests/followup.test.mjs) passed: the Customer review runs after the changed writer, its fingerprint is null, and the independent readiness review is still reused. This establishes both safe invalidation and preservation of valid independent reuse.

### F2 — inconsistent Map, candidate and check evidence

[Gate.prepareDelivery](../../runtime/core/gate.mjs) now uses the engine-owned MapState as the authoritative selection proof. It verifies selected TaskResults, derives the Candidate from the selected verification result, checks the Candidate's assembly sources against selected dependencies, and derives each required CheckReport from the MapState's recorded criterion evidence. Reports must match the approved arguments, timeout, required exit and source kind, and the selected Candidate or task result.

The F2 regression passed: the earlier mixed two-Map summary, another Map's candidate files, and a mismatched selection list are rejected. A coherent summary is accepted. The complete reference-loop tests also passed, including legitimate carried selections and their retained check evidence. The fix therefore does not impose an incorrect same-run restriction.

### F3 — output-format error classification

[The adapter parser](../../runtime/core/adapters.mjs) separates `formatError` from provider/process `error`. [The engine](../../runtime/core/engine.mjs) journals the ambiguous JSON response as `output_contract`, retaining its diagnostic message and publishing no stale answer.

The F3 regression asserts the actual journal error code and passed. The earlier Text-selection regression also passed.

## Acceptance boundary

The source and deterministic engine scenarios support closing the reported code-review defects. The complete reference workflow covers document approval, implementation/checks, final technical review, Customer acceptance and bounded rejection-driven repair or specification revision on fixture CLIs.

The following remain unverified and should be treated as pilot/release validation work:

- a real-provider execution of the full coding pipeline;
- a packaged Tauri crash with live CLI descendants and frontend reconnection;
- installer packaging and installation;
- long-running load and recovery under sustained use.

The direct Windows Job test confirms process-group termination, not the entire packaged-app crash/reconnection path. Fixture model responses prove engine behavior, not real model capability. The runtime bundle and compiler checks do not substitute for installer or load tests.

Recommended next step: a small controlled real-provider pilot, followed by packaged-desktop crash/recovery and load validation. No additional architecture rewrite is required to close F1–F3.
