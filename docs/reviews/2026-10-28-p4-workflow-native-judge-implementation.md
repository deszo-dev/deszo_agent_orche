# Deszo P4 Workflow-native Judge — Implementation and Acceptance Report

**Date:** 2026-10-28
**Verdict:** `P4 IMPLEMENTATION VERIFIED — READY FOR P5`

## Final verdict

The P4.2–P4.7 implementation passed all 13 required P4 E2E scenarios in the final full Node run. The run completed with 909/909 tests passing, zero failures or cancellations, and exit code 0. Rust Host tests, docs validation, production build, and `git diff --check` also passed. A fresh read-only implementation review reported no blocking findings.

This verdict covers the documented supported P4 profile. P4-enabled workflows require a Process Custody Host and the supported sequential profile; unsupported workflow constructs remain refused as described under limitations.

## Source identity and starting state

- Working directory: `C:\my\2026\deszo_agent_orche`
- Branch: `codex/adr-0003-0005-completion`
- HEAD: `3357fb08db5fcb2049d37dd54d9781b6a3b7d528`
- The worktree was already dirty at task start and had no staged changes. P4.1, the Native Windows resource-lifecycle work, and their review documents were already present as working-tree changes. They were preserved; no user changes were overwritten.
- Final state has no staged changes. The implementation report is an additional untracked file.

## P4.2–P4.7 implementation inventory

### P4.2 — Durable attention and Judge-only scheduling

`runtime/core/workflowJudge.mjs` installs the P4 projections and transitions into the existing Engine. Failure attention derives from the captured publication, canonical P3 failure facts, verified evidence, P2 link state, and relevant progress. It is represented by digest-backed journal events and artifacts; no attention table or second queue was added. Since P3 does not persist a separate per-outcome incident handle, the implementation derives a stable incident ID from the captured publication and canonical failure signature. Mutable outcome revisions remain in the evaluation cursor.

`pumpRun` derives `stop`, P2-suspended, `judge_only`, `held`, or ordinary graph behavior from durable state. It opens one eligible attention, journals it, and returns before ordinary graph dispatch. Independent failure incidents are handled one at a time in first-observation journal order. The cursor includes relevant failure ancestors and Repair result/verification ancestors, so unrelated successful work does not invalidate a decision. Finalization rechecks the mandatory-attention barrier within the Store transaction. Stop and existing terminal states take precedence.

### P4.3 — Bounded evidence and trusted typed decisions

The designated Judge uses a strict closed JSON decision union: `wait`, `request_evidence`, `request_repair`, `accept_repair`, `reject_repair`, and `request_human_input`. The Engine verifies exact Attempt, publication, current attention, evidence references, causal cursor, and P2 state before applying a decision. `request_repair` must name the currently authorized pinned profile for the exact failed node and incident; the check is repeated inside the P2 transaction helper. A schema-valid proposal alone does not grant authority.

Evidence packages have provenance and byte/reference bounds. The captured policy caps Judge Attempts at 1–8 per Run; the decision accepts at most eight evidence references, requests at most four references per expansion, and allows one expansion per attention. The initial evidence package is capped at 16 KiB in the Host-backed proof. Expansion accepts only Engine-issued references and reads verified artifact ranges. A rejected or stale proposal cannot create a P2 link or question.

### P4.4 — Process Custody recovery

Judge remains an ordinary Agent Attempt admitted only from durable attention. It uses the existing scheduler, adapter, Host custody record, generation fencing, and Attempt settlement. Recovery reattaches the same live Host-owned invocation; it does not start a duplicate invocation or repeat an unchanged evaluated attention. Uncertain process/side-effect evidence stays held and cannot be overridden by Judge output.

### P4.5 — Typed human input

Migration `m21.sql` adds `workflow_questions`, a one-pending-question-per-root index, and origin/link/decision/publication/policy/artifact bindings. Question and answer-spec content is immutable artifact data. Only validated Judge decisions create questions. The Owner answer route validates the captured choice/text answer spec and is idempotent by request ID. Repair-originated answers schedule only that Repair's Judge; they do not resume or authorize the Parent. Stop, explicit close, and Repair terminalization supersede questions durably.

The runtime exposes `GET /api/v2/runs/:runId/judge-questions` and `POST /api/v2/judge-questions/:questionId/answers`. The private invocation path uses `GET /api/v2/judge-invocations/:invocationId/evidence`, bounded `GET /api/v2/judge-invocations/:invocationId/artifacts/:artifactId`, `POST /api/v2/judge-decisions`, and `GET /api/v2/judge-decisions/:decisionId`; Host-authenticated reads are available through the invocation reads route. The Run UI and MCP bridge expose the bounded question view and typed answer operation, while the Judge worker tools use its scoped invocation token.

### P4.6 — Adaptive P2 Repair

Migration `m22.sql` additively extends the existing `run_links` contract with captured logical-policy authorization, failed-node retry policy, Repair result/verification identity, and `judge_post_execution` acceptance. Existing rows migrate as `expected_digest`; existing expected-digest P2 semantics remain the default. Adaptive approval uses the existing P2 coordinator and pinned Repair publication/profile. The exact designated Repair Judge must approve the completed result and current verification. Parent retry remains governed by the captured `explicit_safe` or `never` policy; Parent Stop wins; nested model-originated Repair is rejected.

### P4.7 — Publication, API, UI, and acceptance

P4.1 `workflow-judge/1` publication identity remains immutable and publication-bound. The Engine, public schemas, Owner API, worker-only decision channel, MCP, and Run UI are integrated. The implementation adds no second scheduler, background worker, model polling loop, generic event broker, binary activation action, or external Judge service. Legacy workflows without `judgePolicy` remain on their existing path.

### Reused components and deviations

- Reused `captureRun`, Engine pump/planning/Attempt settlement, P1 recovery, P3 failure projection, Store journal/artifact verification, P2 linked Repair coordinator, and Rust Process Custody.
- No architecture-level contract was changed. The only representation adaptation is the deterministic incident ID derivation noted above because P3 does not persist a separate incident handle.
- Runtime admission is fail-closed outside the supported profile. P4 requires an available Process Custody Host and refuses workflows containing Loop/Map/Task nodes or Context-bound Agents.

## P4-E2E-01–13 acceptance proofs

All rows passed as `node:test` cases within the final `npm test` command (exit code 0). The first three use the real Rust Lifecycle/Process Custody Host and deterministic Rust provider fixture. The remaining scenario tests use the real in-process Engine and SQLite Store with a deterministic scripted Host.

| ID | Selector / proof | Result and crash-boundary evidence | Execution harness |
|---|---|---|---|
| 01 | `workflow-judge-runtime.test.mjs`: “P4-E2E-01 and P4-E2E-08…” — failure/admission subtest | Pass. Failure commits one attention, the Judge runs once, ordinary graph work remains held, and restart after evaluated wait does not repeat inference. | Real Rust Host + deterministic Rust provider |
| 02 | `workflow-judge-runtime.test.mjs`: “P4-E2E-02 and P4-E2E-12…” | Pass. Engine A is killed during a live Judge CLI; B reattaches the same Attempt/PID and C does not duplicate the invocation. | Real Rust Host + deterministic Rust provider |
| 03 | `workflow-judge-runtime.test.mjs`: “P4-E2E-03…” | Pass. Fault after atomic decision settlement leaves the P2 link and queued Repair durable before dispatch; B dispatches once and C does not repeat it. Captured `failed_node_retry=never` keeps Parent blocked. | Real Rust Host + deterministic Rust provider |
| 04 | `workflow-judge-scenarios.test.mjs`: “P4-E2E-04 and P4-E2E-05…” — `explicit_safe` approval subtest | Pass. Approved Repair resumes the Parent once under the captured retry policy. | In-process Engine/SQLite + scripted Host |
| 05 | Same selector — `never` and rejection subtests | Pass. `never` does not replay the Parent; rejection fails Repair and leaves Parent suspended. | In-process Engine/SQLite + scripted Host |
| 06 | `workflow-judge-scenarios.test.mjs`: “P4-E2E-06 and P4-E2E-12…”; “P4-E2E-06 and P4-E2E-11…” | Pass. A Repair question survives restart; one answer resumes only the originating Repair Judge. Parent Stop supersedes the question and rejects late input. | In-process Engine/SQLite + scripted Host |
| 07 | `workflow-judge-scenarios.test.mjs`: “P4-E2E-07…” | Pass. Developer and Watcher output cannot create a persisted Owner question. | In-process Engine/SQLite + scripted Host |
| 08 | Runtime E2E-01/08 group and `workflow-judge-scenarios.test.mjs`: “P4-E2E-08 evidence expansion…” | Pass. Idle success uses no Judge Attempt; evidence expansion is bounded, issued-reference-only, and visible to the follow-up Judge. | Runtime proof uses real Rust Host; expansion proof uses in-process Engine/SQLite + scripted Host |
| 09 | `workflow-judge-scenarios.test.mjs`: “P4-E2E-09…” | Pass. Uncertain Host termination keeps the workspace held and prevents Judge and Repair admission. | In-process Engine/SQLite + scripted Host with uncertain Host result |
| 10 | `workflow-judge-scenarios.test.mjs`: “P4-E2E-10…” | Pass. A P3 revision during inference invalidates the cursor; stale Judge output is rejected with no P2 effect. | In-process Engine/SQLite + scripted Host |
| 11 | Scenario E2E-06/11 question test and “P4-E2E-11: Stop supersedes a live Judge decision…” | Pass. Stop supersedes both pending Repair questions and a live Parent Judge before a stale decision can create a Repair link. | In-process Engine/SQLite + scripted Host |
| 12 | Runtime E2E-02/12 group and scenario E2E-06/12 question test | Pass. Live invocation reattachment preserves one Judge Attempt across A/B/C; Repair question recovery routes one answer only to its originating Judge. | Runtime proof uses real Rust Host; question proof uses in-process Engine/SQLite + scripted Host |
| 13 | `workflow-judge-scenarios.test.mjs`: foreign Judge, forged authority, wrong Repair lineage, and incomplete-verification cases | Pass. Foreign Parent/Repair Judges, malformed authority fields, and stale verification cannot approve a linked Repair. | In-process Engine/SQLite + scripted Host |

Additional P4 checkpoint proofs passed in the same full run: CP-02 stale attention supersession, CP-03 pre-commit decision replay and duplicate question application, CP-05 Repair-question arbitration, exact failed-node/profile matching, and nested Repair refusal.

## Regression and final gates

| Gate | Result |
|---|---|
| Focused P4 policy/runtime/scenario set | 49/49 passed, exit 0 (run during implementation stabilization) |
| Final `npm test` | 909 passed, 0 failed, 0 canceled; 878 top-level tests; exit 0; 1:06:02.059. Captured at `%TEMP%\deszo-p4-npm-test-final-2026-10-28.log`. |
| `cargo test --manifest-path lifecycle-host/Cargo.toml` | 23 passed, 0 failed; exit 0. |
| `npm run docs:check` | Passed; 0 errors. 33 schemas, 141 positive and 82 negative schema cases, 42 negative semantic cases, 143 Markdown files, 1,259 local links, 17 Mermaid diagrams, 50 decision cases, and migration SQL checks passed. |
| `npm run build` | Passed (`tsc -b && vite build`). Vite emitted its advisory that one minified chunk is 694.82 kB, above the 500 kB warning threshold. |
| `git diff --check` | Exit 0; no whitespace errors. Git printed LF-to-CRLF working-copy notices for Windows-touched files. |

### Earlier full-run diagnostics

Earlier full attempts were not used as final acceptance. The first reported 906 passes and three transient failures: a Host terminal-state observation racing the Host record update in `P2-E2E-02`, a provider-process exit observation racing Run interruption in `P1-10`, and a Windows `EPERM` during atomic rename of `runtime/connection.json`. All three focused selectors passed on isolated rerun. The first two tests now wait for terminal evidence rather than sampling immediately; the rename case did not reproduce.

A later run reported 907 passes and two failures. One was the supervised-containment test treating a reused Windows PID as a surviving original process; it now compares process creation identity, and its focused rerun and the final full run passed. The streamed output did not preserve the selector for the other historical failure, and no separate per-run log was available. The final full run on the final source candidate completed with 909/909 passing and no unexplained failure in that run.

The final Node run printed the test-artifact warning that some roots could not be removed. Read-only `node scripts/test-artifacts.mjs status` reported three dead owners with one retained root apiece, 18 failure bundles (652 files, 12,768,759 bytes), and unowned historical entries including `.deszo/tests/root`, desktop-host-proof roots, and `%TEMP%/deszo-empty-hooks`. No artifacts or roots were deleted; the suite exit code remained 0. This is a test-artifact hygiene limitation, not a P4 test failure.

## Security review

- Judge authority is bound to the exact live designated Attempt, captured publication, current attention/cursor, and closed decision schema. An ordinary `role="judge"` marker does not confer P4 authority.
- Decision settlement and authorized effect are committed in the Store transaction. Stale or duplicate output cannot replay a logical action. P2 Repair creation is restricted to the pinned, exact-failure profile and revalidated in the coordinator transaction.
- Human questions originate only from valid Judge decisions. Owner answers are authenticated, typed, exact-spec, and idempotent. A Repair answer cannot resume the Parent.
- Stop and terminal state supersede stale Judge decisions/questions. Uncertain process evidence remains held; P4 does not claim arbitrary external effects are exactly-once.
- No binary activation, arbitrary command action, or provider-created P2 authority was added.
- Owner Token residual risk AR01 remains: a same-user Full Access process that can read the Owner Token can call public Owner APIs. Environment scrubbing is not operating-system isolation. The worker decision token is scoped to the invocation and does not replace or widen Owner authority.

## Compatibility and preserved invariants

- P4.1 policy publication, immutable version identity, exact Run capture, and legacy compatibility remain intact.
- A legacy Judge role without `judgePolicy` remains an ordinary Agent and receives no P4 authority.
- P2 expected-digest links remain backward-compatible; `m22.sql` migrates old rows into that mode.
- Non-P4 recovery continues through the existing Engine path. P4 barriers block only the native-P4 recovery actions they govern.
- Native Windows resource fixes remain present: Branch Delivery hook ownership, waiting for Git process-tree termination, preserving resources when termination is unproven, ControlHost SQLite cleanup, and managed-task process termination handling. The final Node suite and desktop containment proofs passed.

## Independent read-only review

A fresh-context reviewer examined the implementation and source changes. No Critical, High, or contract-breaking Medium finding remains. Checklist outcomes (questions 1–12, 15, and 20 ask whether an unsafe condition is possible):

| # | Review question outcome | # | Review question outcome |
|---:|---|---:|---|
| 1 | No — Judge cannot run without eligible durable attention. | 11 | No — uncertain external effects are not replayed without proof. |
| 2 | No — graph work cannot bypass an unresolved Judge barrier. | 12 | No — nested model-originated Repair is refused. |
| 3 | No — finalization rechecks attention transactionally. | 13 | Yes — legacy expected-digest P2 remains supported. |
| 4 | No — recovery does not duplicate a live Judge launch. | 14 | Yes — Owner Token and Host authority semantics are preserved. |
| 5 | No — schema validity alone cannot mutate P2. | 15 | No — P4 cannot activate binaries. |
| 6 | No — decision receipt and durable effect share a transaction. | 16 | Yes — idle P4 spends zero Judge invocations. |
| 7 | No — a foreign Repair Judge cannot approve. | 17 | Yes — evidence bounds and issued-reference checks are enforced. |
| 8 | No — a Repair answer cannot resume the Parent. | 18 | Yes — migrations are additive/backward-compatible. |
| 9 | No — manual recovery cannot bypass P4 barriers. | 19 | Yes — Windows resource-lifecycle fixes remain present. |
| 10 | No — Stop supersedes a stale Judge decision. | 20 | No — no second scheduler/service/model loop was introduced. |

The reviewer noted the existing Native Windows resource cleanup check-to-delete race: allocation identity is checked before recursive removal, but the check and deletion are not atomic. It predates P4 and was not expanded into this task. The reviewer inspected migration source; the full Node suite independently exercised migration tests.

## Remaining limitations

- P4 runtime admission is limited to workflows with an available Process Custody Host and the supported sequential, non-Context execution profile. Loops, Maps, Managed Tasks, and Context-bound Agents are refused for native P4.
- Existing Owner Token AR01 and the pre-existing resource path check-to-delete race remain as described above.
- Test artifact reconciliation reported retained historical roots/failure bundles after the final successful run. They were left untouched under the no-destructive-cleanup instruction.
- P5, P6, P7, and P8 capabilities remain out of scope.

## SHA-256 source identity

Hashes below identify final P4 implementation, public integration, persistence, and acceptance-test sources. Additional Native Windows/P4.1 baseline files are listed in the Git inventory but are outside this focused hash set.

| File | SHA-256 |
|---|---|
| `docs/schemas/journal-event-v2.schema.json` | `E42DA83C2A86279FFF1CC434137888FB5B1E0FC31A99A82BBE03FD88B559485B` |
| `docs/schemas/runtime-api-v4.schema.json` | `63F97039ECBCB496CA2DFE7D727858308C44DDFC5E5D254C1BF54DE39077B43D` |
| `docs/schemas/workflow.schema.json` | `2795F2AD61898AA2ECFC1B7FE89302E40DF9680DA60CD8212F460E1CBCB78C83` |
| `docs/schemas/workflow-judge-decision.schema.json` | `264CEE5ED9C529F7CFB28A91E5BE8E9E4D1A1CAAFD290480BEBA6F2201D4C584` |
| `docs/storage/m21.sql` | `29E41322A3B0A062EDE3D6FC2B93570FB70022817B6EB1FFBE23CADC1A6B28BD` |
| `docs/storage/m22.sql` | `6FABCF99E5456667F2AE278AA3F1FA2FEAA6A3751E2439D8E0E60BC31AB61B73` |
| `runtime/core/workflowJudge.mjs` | `6C0C122F27D7CDAA6929AC1011515C43047B08D5F7C15324E8BA96EDF2A646EA` |
| `runtime/core/engine.mjs` | `40C66D495F689A0E0CAEFA3CA54F6719FB9161C0D5386DA4252EA22EDE28D64D` |
| `runtime/core/linkedRepair.mjs` | `B8EAE9519FF489EA8C95DF6D802E8708AFD0DC56870AB8FD8EC1A4A6863E17F3` |
| `runtime/core/migrations.mjs` | `1721F4C56B498559A9AA259419C99DEA72D8FE520D88F1527C7853649B985E23` |
| `runtime/core/schemas.mjs` | `50B05343EBFCB45D5B72438CA39C19FA840A32355688D406357B9F2EF5F82194` |
| `runtime/core/validate.mjs` | `4985D264EFF8FF761EEDB636581332A71611BA298CF158A383C8E81B173BDD56` |
| `runtime/host/authority.mjs` | `0E27C4DF11A7D63C83A777714E2A1E6488CEF4CC7084529B1492EDDB37CF43C9` |
| `runtime/runner.mjs` | `6C3593EA493F540D9251479232EF6589B775ACE43F7810FC75E59B47F20D3B3B` |
| `mcp/bridge.mjs` | `30C00741FA578C2A96D2D0E72376525FB3D60F37DC8F2A0912085AF29B97F861` |
| `src/App.tsx` | `26C50475C398A3420200957129FF2448A4C2650E52A14E0B2203549A3DBE6F4D` |
| `src/styles.css` | `40BE32B4139FDCB1B61F566C5F55CE084B1F0C626225262DDE7DC19AA4BC8C86` |
| `src/types.ts` | `F129F6F74722D62E2A2F589D366D23353DA6059A62D8F051E71B60CCA04FF6FC` |
| `runtime/tests/workflow-judge-policy.test.mjs` | `4DB88D8E863F8E5638D38AEC7CE85F027B902811C69C54BBBED6F3C4B15AD956` |
| `runtime/tests/workflow-judge-runtime.test.mjs` | `CE3371BDFDE2BAD47A91BD5C73D5DAFE12178FD63FE1EB74A81E97ABCE8809D1` |
| `runtime/tests/workflow-judge-scenarios.test.mjs` | `AA8891A1C0CC3E307970C0030E8BC3143676E44E714109424228AE4F3BE41B3E` |
| `runtime/tests/parent-repair-custody-e2e.test.mjs` | `1DA2B95B860F961CCFB0973A18D7BBF7320DEAB25E6C83F780CA6E7EE59DD7D1` |
| `runtime/tests/workflow-p1-continuation.test.mjs` | `DB1A6A77EB1A3E41D1379B927FDD111BE7C05FC4E3DE0F1E76B1D192EE9050EE` |
| `runtime/tests/tauri-host-proof-b.test.mjs` | `DD3D03E37F1DD2DF7CD6AFEA609F690DBD6E84332134E0E42C398B323085DB68` |

## Final Git inventory and operation policy

### Tracked modified files

`docs/schemas/journal-event-v2.schema.json`, `docs/schemas/runtime-api-v4.schema.json`, `docs/schemas/workflow.schema.json`, `mcp/bridge.mjs`, `runtime/core/branchDelivery.mjs`, `runtime/core/custody.mjs`, `runtime/core/engine.mjs`, `runtime/core/linkedRepair.mjs`, `runtime/core/migrations.mjs`, `runtime/core/processes.mjs`, `runtime/core/schemas.mjs`, `runtime/core/taskProcesses.mjs`, `runtime/core/validate.mjs`, `runtime/host/authority.mjs`, `runtime/runner.mjs`, `runtime/tests/adr6-regressions.test.mjs`, `runtime/tests/amd19-authorization.test.mjs`, `runtime/tests/branch-delivery.test.mjs`, `runtime/tests/fixtures/custody-cli.rs`, `runtime/tests/managed-task.test.mjs`, `runtime/tests/p2-migration.test.mjs`, `runtime/tests/parent-repair-custody-e2e.test.mjs`, `runtime/tests/tauri-host-proof-b.test.mjs`, `runtime/tests/workflow-p1-continuation.test.mjs`, `src/App.tsx`, `src/styles.css`, `src/types.ts`.

### Untracked files retained or added

`docs/reviews/2026-10-27-native-windows-resource-verification.md`, `docs/reviews/2026-10-27-p4-workflow-native-judge-architecture.md`, `docs/reviews/2026-10-27-resource-lifecycle-leak-closure.md`, `docs/reviews/2026-10-28-p4-1-policy-integration.md`, `docs/reviews/2026-10-28-p4-workflow-native-judge-implementation.md`, `docs/schemas/workflow-judge-decision.schema.json`, `docs/storage/m21.sql`, `docs/storage/m22.sql`, `runtime/core/workflowJudge.mjs`, `runtime/tests/workflow-judge-policy.test.mjs`, `runtime/tests/workflow-judge-runtime.test.mjs`, `runtime/tests/workflow-judge-scenarios.test.mjs`.

No files were staged. No commit, push, merge, rebase, reset, or destructive cleanup was performed. Historical test artifacts and pre-existing working-tree changes remain preserved.
