# Deszo P3 — Failure Detection, Typed Outcomes, and Durable Evidence

**Verification date:** 2026-10-27  
**Branch / base:** codex/adr-0003-0005-completion / abb7295e6339912b5be16fc4db2a8e244e0c1bfc  
**Final verdict:** P3 TYPED FAILURE OUTCOMES VERIFIED — READY FOR P4

## 1. Mission and baseline

P3 adds a durable, bounded description of relevant Run and Attempt failures for a future workflow-native Judge. It records observed state, deterministic classification, uncertainty, and durable evidence references. It does not decide whether to retry, repair, suspend a Parent, or ask for approval.

Before P3, the runtime already had strict journal error enums, Run and Attempt state transitions, Host custody records and spool evidence, SQLite persistence, restart reconciliation, workspace holds, and P2 Parent/Repair coordination. The gaps were that errors from different origins could collapse to the same journal code, the journal had no typed incident description with explicit certainty, no durable projection supported a bounded typed read, and repeated recovery observations needed a stable outcome identity.

The implementation leaves the Run/Attempt state machine and P2 Owner-authorized Repair contract in place. Historical failures remain readable and are reported as an untyped legacy coverage gap; no history is rewritten.

## 2. Audit mapping

| Existing signal | Source and prior representation | Ambiguity | P3 action |
|---|---|---|---|
| Provider exits unsuccessfully | Provider parser/process result and Attempt error | A process result alone does not say whether the workflow task or Deszo failed | Record the source and canonical code; distinguish provider failure from workflow output-contract failure |
| Provider authentication/access refusal | Provider error code, commonly authentication or permission | Raw diagnostics may contain credentials and are not a safe contract | Use a bounded safe summary and allowlisted code; do not copy credential-shaped diagnostic text |
| Host unreachable | Custody transport/request error; Attempt may stay unresolved | Communication failure is not proof that a process ended | Preserve unresolved execution and side-effect certainty; retain Host state as unavailable |
| Host refuses launch | Host response, while compatibility journal codes may include provider_unavailable | A compatibility code can misstate provenance | Preserve source=host; categorize by provenance as orchestrator failure, not provider failure |
| Process tree not proven ended | Host process-tree status and workspace hold | Exit of the leader or loss of Host reply does not prove descendants ended | Keep execution uncertain and the hold; only authoritative terminal proof can settle it |
| Incomplete spool/capture | Host spool metadata or capture_failed/capture_limit error | Successful process exit does not prove complete captured output | Record capture status and evidence; do not infer a valid successful result from incomplete capture |
| Workspace conflict | Existing workspace validation and workspace error codes | Refusal is not necessarily a provider failure or a completed Attempt | Retain the originating Engine/workflow source and its canonical code; classification cannot release a hold |
| Engine/runtime invariant or persistence failure | Engine/Store exception and existing corruption/process errors | Raw external codes can be invalid journal enum values | Normalize to the strict canonical enum and record Engine provenance |
| External side effect uncertain | Lost launch reply, Engine absence, or Host outage | It may be unknown whether a process ran or a side effect occurred | Use executionCertainty=unresolved/unknown and sideEffectCertainty=unknown; no blind retry authority |
| User Stop / authorized cancellation | Control transition and Attempt state change | Cancellation must not be mislabeled as provider failure | Record external_control provenance and control_outcome category |
| Repair result rejected or Repair fails | Existing P2 incident and Parent/Repair association | A diagnostic must not grant acceptance or Parent continuation | Link typed evidence to the P2 association while preserving existing expected-digest and retry authorization |

The strict pre-existing journal enum remains authoritative for canonical codes. Unknown raw codes are not passed through unchecked. For example, ENOENT during a provider executable launch can normalize to provider_unavailable when provider provenance and launch operation are known; an Engine checkpoint/storage ENOENT does not inherit that provider meaning.

## 3. Typed outcome contract

The strict schema is docs/schemas/failure-outcome.schema.json. Each record includes:

- Stable outcomeId, schemaVersion, revision, Run identity, and Attempt/node identity when an Attempt exists.
- Source: engine, host, provider, workflow, external_control, or recovery.
- Category: task_failure, provider_failure, orchestrator_failure, execution_uncertain, or control_outcome.
- Canonical journal code, observed Run/Attempt/Host state, and optional safe raw code restricted to a 64-character allowlist.
- causeKnowledge: direct_fact, deterministic_interpretation, or unknown.
- executionCertainty: not_started, completed, unresolved, or unknown; sideEffectCertainty: none_proven, effect_confirmed, or unknown.
- A bounded safe summary and typed references to journal events, artifacts, custody invocations, published versions, workspace holds, or P2 incidents.

Attempt outcomes use the Attempt ID as their stable identity. Run-scoped outcomes require a caller-provided stable identity; published-definition recovery refusal uses a deterministic UUID derived from the Run and refusal reason. Run-only outcomes have no fabricated Attempt or node fields. Repeated observations update the same outcome revision instead of creating another incident.

Provenance precedes compatibility code in category selection. Thus a Host launch refusal can keep a schema-valid provider_unavailable journal code while remaining an orchestrator_failure from source=host. A Host outage without terminal proof is execution_uncertain. External control is control_outcome. Workflow output-contract failures are task_failure. The classification describes evidence and does not authorize a follow-up action.

## 4. Durability, event atomicity, and recovery

The append-only journal stores attempt.failure_outcome / run.failure_outcome and their update events. Migration docs/storage/m20.sql adds the failure_outcomes SQLite projection, keyed by outcome_id and uniquely associated with an Attempt when applicable. It stores first/latest journal sequence, revision, and canonical outcome JSON for bounded reads.

Store.appendEvents writes the journal record and projection update within the existing Store transaction alongside the corresponding state/evidence events. Journal evidence references are resolved from the related event batch. Engine recovery reads persisted outcomes and reconciles Host terminal evidence against the original Attempt and Custody invocation; it does not launch a replacement process. Cancellation and Run-owned utility failure paths now persist their related state, event, and typed outcome transactionally.

The owner-authenticated route GET /api/v2/runs/:runId/failure-outcomes/page is bounded (limit 1–200) and ordered by journal sequence. It reports legacy untyped failures separately. The MCP bridge exposes read-only list_failure_outcomes; its result is marked untrusted evidence and explicitly conveys no retry or recovery authority.

Uncertain Host communication is kept separate from terminal evidence. A refused or unavailable Host command leaves process-tree completion unproven and keeps the workspace hold. Later Host proof updates the existing outcome identity and references. Classification never releases a hold or retries unknown side effects.

## 5. P1/P2 compatibility and security

P1 continuation keeps the same Run/Attempt state model and restart eligibility. P2 retains Owner-authorized Repair, expected result digest, retry policy, and Parent continuation rules; P3 adds evidence references without changing who can accept a Repair or resume a Parent.

The typed summary is bounded and uses allowlisted fields rather than unrestricted provider diagnostics. The auth-failure fixture includes credential-shaped text and verifies that the typed outcome omits it. MCP outcome results are labeled untrusted. No Owner Token, provider credential, environment dump, or raw transcript is added to an outcome.

## 6. Tests and machine evidence

The focused runtime/tests/failure-outcomes.test.mjs suite passed 7/7 and includes actual Engine/SQLite tests plus three real Rust Lifecycle Host-backed E2Es. Additional focused checks passed: managed-task root/task/command Stop subtests 4/4; unresolved Host refusal 1/1; published-definition recovery refusal 1/1; AMD-19 route inventory 1/1.

| ID | Test and execution level | Result and evidence |
|---|---|---|
| P3-E2E-01 | Settled provider failure retained after Engine replacement; actual Engine, SQLite, deterministic provider fixture, real Rust Host | Passed. Same Run/Attempt/outcome identities and evidence resolve after replacement; no duplicate terminal record and no relaunch |
| P3-03/P3-22 | Provider authentication failure with credential-shaped diagnostic; actual Host-backed execution fixture | Passed. Typed summary excludes credential-shaped text |
| P3-E2E-02 | Rust Host failure evidence reconciled after Engine absence; actual Rust Host, Engine, SQLite, deterministic custody fixture | Passed. Same Custody invocation and spool evidence reconcile; no second provider launch |
| P3-E2E-03 | Temporary Host outage then reconciliation; actual Rust Host, Engine, SQLite, deterministic custody fixture | Passed. Initial uncertainty and hold are retained; later terminal proof updates the same outcome identity without relaunch |

The per-test scratch stores are cleaned by the fixtures, so no persisted sample Run IDs are claimed. Machine-readable details are in docs/reviews/evidence/2026-10-27-p3-typed-failure-outcomes-e2e.json. Source hashes are in docs/reviews/evidence/2026-10-27-p3-typed-failure-outcomes-source-manifest.json; all 28 listed file hashes matched at the final source check (manifest SHA-256 67f04ff7afab525dbeab1a2d634d403b9efc431ec1ba7edb611b86ad5bc6f3d3).

## 7. Independent review

A fresh-context, read-only review inspected the changed source. Feedback on source mapping, legacy failure coverage, transient Host state, Parent/Repair linkage, Run-scoped identity, cancellation provenance, atomic utility-failure settlement, uncertainty wording, recovery evidence, transactional Stop paths, and Host refusal versus transport unavailability was resolved in the candidate. The reviewer’s final assessment had no remaining P1/P2/P3 blockers.

## 8. Initial regression record (historical)

This section preserves the original full-suite result recorded before recovery. Its failed test result is superseded for acceptance by the recovery and clean full-suite evidence in §12; the original failures remain part of the diagnostic history.

| Command | Passed | Failed / limitation | Exit code |
|---|---|---|---:|
| npm test | 786 top-level results observed passing through test 791 | 5 failures observed; run then had no TAP output for over 11 minutes and was interrupted before aggregate summary | 1 |
| cargo test --manifest-path lifecycle-host/Cargo.toml | 23/23 Rust tests on elevated rerun | Initial sandbox run was blocked by Windows atomic-replacement and symlink privileges; elevated rerun passed | 0 |
| npm run docs:check | 32 schemas; 141 positive and 82 negative schema cases; 42 semantic negative cases | 0 validator errors (138 Markdown files, 1,246 local links) | 0 |
| npm run build | TypeScript and Vite production build passed | Vite emitted its existing >500 kB chunk-size advisory | 0 |
| git diff --check | Clean; no whitespace errors | 0 | 0 |

The five observed Node failures were:

1. SP-04 timed out waiting for Engine exit at after_ack (~93.7 s).
2. SP-06 timed out waiting for Engine exit at after_settle (~94.0 s).
3. SP-07 timed out waiting for Host exit during spool write (~93.6 s).
4. P2-E2E-05 expected one Parent A side effect before Repair but observed zero.
5. P2-E2E-06 expected one Parent A side effect before Repair but observed zero.

The runner reached 791 numbered top-level results but did not print an aggregate TAP footer. Its attached session was interrupted only after the long silent interval and returned exit code 1. The last three P3-specific cases (tests 545–548, including the auth fixture) had passed in that run. The two P2 side-effect failures are in pre-existing P2 test changes; their cause is not established. In a focused selector, P2-E2E-05 passed and P2-E2E-06 failed after it. P2-E2E-06 then passed 1/1 when run alone against its restored test source. This indicates an order-sensitive interaction, but does not clear the full-suite failures or prove they are unrelated to current Engine changes.

## 9. Limitations and deferred work

Accepted P3 limits: older journal failures may remain untyped and are counted as such; P3 does not reclassify historical records, store duplicate raw logs, guarantee exactly-once delivery to arbitrary consumers, or infer whether an unobserved external side effect occurred. Host/Engine reconciliation remains evidence-based rather than a distributed transaction.

Deferred by scope: P4 workflow-native Judge decisions; P5 Protected Self-Repair; P6 binary activation; P7 autonomous trigger; P8 general workflow continuation. P3 does not automatically start Repair, select retries, suspend a Parent, or request user input.

## 10. P4 readiness

Yes: the Judge can consume durable, typed evidence without reparsing provider logs. The smallest trusted read contract is the owner-authenticated, bounded Run-scoped failure-outcome page, with existing authorized journal/artifact reads to resolve evidence references. The MCP list_failure_outcomes tool is a read-only untrusted projection of that contract.

P4 should submit its own decision through a separately authenticated, schema-validated Engine command that appends its decision to the journal. It must not treat an outcome classification as permission to retry or repair. P3 implements no Judge decision path.

## 11. Git state and proposed staging inventory

Branch codex/adr-0003-0005-completion; HEAD abb7295e6339912b5be16fc4db2a8e244e0c1bfc. The index was empty at inventory. Stashes were stash@{0}: On main: codex: preserve ADR-0003-0005 before main fast-forward and stash@{1}: On codex/shadcn-ui: 11. Nothing was staged, committed, pushed, merged, rebased, reset, or cleaned.

P3-only production/schema files: docs/schemas/failure-outcome.schema.json; docs/schemas/journal-event-v2.schema.json; docs/schemas/runtime-api-v2.schema.json; docs/storage/m20.sql; mcp/bridge.mjs; runtime/core/custody.mjs; runtime/core/failureOutcomes.mjs; runtime/core/linkedRepair.mjs; runtime/core/mapRuntime.mjs; runtime/core/migrations.mjs; runtime/core/schemas.mjs; runtime/core/store.mjs; runtime/core/taskProcesses.mjs; runtime/core/taskRuntime.mjs; runtime/runner.mjs.

P3-only or P3-focused test files: runtime/tests/amd19-authorization.test.mjs; runtime/tests/custody-terminal-settlement.test.mjs; runtime/tests/custody-unresolved.test.mjs; runtime/tests/failure-outcomes.test.mjs; runtime/tests/integrity.test.mjs; runtime/tests/loops.test.mjs; runtime/tests/map.test.mjs.

Mixed P2/P3 files requiring hunk-level review before any future staging: runtime/core/engine.mjs; runtime/tests/fixtures/custody-cli.rs; runtime/tests/parent-repair-coordination.test.mjs; runtime/tests/p2-migration.test.mjs; runtime/tests/workflow-continuation-negative.test.mjs; runtime/tests/workflow-p1-continuation.test.mjs.

Pre-existing P2-only dirty paths preserved: runtime/tests/custody-support.mjs; runtime/tests/parent-repair-custody-e2e.test.mjs; runtime/tests/fixtures/p2-d25-stop-commit-barrier.mjs; docs/reviews/evidence/2026-10-27-p2-d25-engine-replacement-initial.json; docs/reviews/evidence/2026-10-27-p2-d25-engine-replacement.json; docs/reviews/evidence/2026-10-27-p2-d25-final-source-manifest.json; docs/reviews/evidence/2026-10-27-p2-d25-source-manifest.json.

P3 documentation/evidence: this report; docs/reviews/evidence/2026-10-27-p3-typed-failure-outcomes-e2e.json; docs/reviews/evidence/2026-10-27-p3-typed-failure-outcomes-source-manifest.json; docs/reviews/evidence/2026-10-27-p3-regression-recovery-source-manifest.json; docs/reviews/evidence/2026-10-27-p3-regression-recovery.json. The proposed P3 staging set is the P3-only files plus only the P3 hunks from mixed files; preserve the listed P2-only changes separately.

## 12. Final regression recovery and acceptance closure

The original full run recorded five failures and ended without a TAP footer. The SP-04/06/07 custody selector subsequently passed 5/5. A first six-case P2 selector had one timeout and dependent marker failures; isolated P2-E2E-02/03 runs passed, and a later six-case rerun passed 6/6. These selector logs are `docs/reviews/evidence/2026-10-27-p3-recovery-custody-focused.tap.log`, `docs/reviews/evidence/2026-10-27-p3-recovery-p2-focused.tap.log`, `docs/reviews/evidence/2026-10-27-p3-recovery-p2-e2e02.tap.log`, `docs/reviews/evidence/2026-10-27-p3-recovery-p2-e2e03.tap.log`, and `docs/reviews/evidence/2026-10-27-p3-recovery-p2-focused-rerun.tap.log`. That earlier sequence failure remains unexplained and is not presented as unrelated to the code.

A later full run overlapped with a second `npm test`. It finished with 847 tests, 802 passed and 45 failed (exit 1), including Rust linker `LNK1104` failures and other contention symptoms. The diagnostic log is `docs/reviews/evidence/2026-10-27-p3-final-npm-test.tap.log`; it is retained as evidence and excluded from acceptance. The independent read-only recovery review found no remaining issue in the bounded test changes and no blocker to a fresh final run.

After stale test-owned processes were identified and stopped, one uncontested `npm test` completed with TAP footer `1..838`, 847 tests, 847 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo, duration 2,941,878.097 ms, exit 0. The full log is `docs/reviews/evidence/2026-10-27-p3-clean-final-npm-test.tap.log`. It includes passing SP-04/06/07, all six P2 custody E2Es, Tauri Host replacement and containment, and the final recovery cases.

Final checks also passed: `cargo test --manifest-path lifecycle-host/Cargo.toml` (23 passed, 0 failed); `npm run docs:check` (32 schemas, 141 positive and 82 negative schema cases, 42 negative semantic cases, 138 Markdown files, 1,250 local links, 0 errors); `npm run build` (TypeScript and Vite production build; Vite emitted the existing chunk-size advisory); and `git diff --check` (no whitespace errors). Their logs are `docs/reviews/evidence/2026-10-27-p3-final-cargo-test.log`, `docs/reviews/evidence/2026-10-27-p3-final-docs-check.log`, `docs/reviews/evidence/2026-10-27-p3-final-build.log`, and `docs/reviews/evidence/2026-10-27-p3-final-diff-check.log`.

The recovery source manifest binds 32 source files; every SHA-256 matched at closure. Its own SHA-256 and the full-run footer are recorded in `docs/reviews/evidence/2026-10-27-p3-regression-recovery.json`. The working tree remains on `codex/adr-0003-0005-completion` at `abb7295e6339912b5be16fc4db2a8e244e0c1bfc`; the index is empty. No commit, push, merge, rebase, reset, or cleanup was performed. P2 changes remain preserved in the working tree.
