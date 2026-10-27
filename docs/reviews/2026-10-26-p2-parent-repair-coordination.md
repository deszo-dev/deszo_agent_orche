# P2 Parent / Repair Coordination

**Date:** 2026-10-26  
**Branch/base:** `codex/adr-0003-0005-completion` at `40fa26a` (P2 changes are uncommitted)  
**Scope:** Durable suspension of an existing Parent Run, isolated linked Repair, exact logical outcome acceptance, Engine recovery, and automatic continuation of the original Parent.

## 1. Mission and scope

P2 adds durable coordination to the existing Engine and `run_links` lifecycle. It does not add a scheduler, failure classifier, Judge, autonomous repair trigger, binary activation path, app-server, or general retry facility. The Repair is a separate ordinary published workflow Run. Only the Owner-authenticated control request can establish the relationship, and it names the exact Repair result digest and Parent-node retry policy.

P2 supports sequential workflow definitions without Loop, Map, or Task nodes. An accepted Repair result means the selected text artifact matches the Owner-authorized SHA-256. It does not mean that a new binary was built, activated, or generally safe to deploy.

## Verdict

**P2 PARENT/REPAIR COORDINATION VERIFIED**

The required Parent→Repair→Parent lifecycle is proven through real Engine replacement, durable SQLite coordination, the Rust Lifecycle Host, isolated workspace roots, immutable published-version pins, accepted logical resolution, and exactly-once Parent continuation. P2-E2E-01 through P2-E2E-05 cover active Repair recovery, Host completion while Engine is absent, accepted-outcome recovery, failed Repair, and repeated Engine replacement. The independent review found no blocking issue. The separate Parent-Stop callback-loss scenario passes deterministic Host-backed reconciliation, with the test-depth caveat documented under limitations.

## 2. Baseline architecture and existing Parent/Repair mechanisms

The checkout already had ADR-0008 linked Repair in `runtime/core/linkedRepair.mjs`, migration M14, physical-root checks in `workspaceIsolation.mjs`, P1 published-version checks, Custody recovery, and Host-backed lifecycle tests. The old link creates a distinct Repair Run from a Parent in `waiting_for_user`, requires a failed/canceled node, records a candidate/checkpoint, isolates roots, and resumes the Parent after Repair success. That path is retained for lifecycle activation and its existing tests.

The old link conflated lifecycle and logical continuation, used `waiting_for_user` as the Parent hold, had no incident identity or exact logical outcome, and P1 intentionally excluded all linked Runs from restart continuation. Existing lifecycle proofs demonstrated candidate activation and receipt handling; they did not prove an Owner-authorized result policy followed by Parent→Repair→Parent recovery.

## 3. Audit: confirmed gaps and minimal changes

| Concern | Existing mechanism | Confirmed gap | P2 change |
|---|---|---|---|
| Parent suspension | `waiting_for_user`, open `run_links`, P1 scheduler state rebuild | No distinct durable Repair suspension intent/status; scheduler could not distinguish it from human wait | Persist `suspension_requested`, `suspended_for_repair`, `resumable`, `resumed`, `stopped`, or `blocked` on the link; gate Parent dispatch there |
| Repair link | M14 links distinct Run IDs and workspace IDs | Link represented lifecycle activation, not a logical outcome contract | Add `continuation_contract`; keep legacy links as `lifecycle`, use `logical_policy` for P2 |
| Incident identity | No incident key | Duplicate incident could create another Repair | Add unique `incident_id` and replay lookup; command receipt plus transaction makes identical request replay idempotent |
| Repair start | Existing path starts after failed Parent node and uses a Judge lifecycle proposal | No explicit Owner control contract for exact published Repair/result policy | Extend existing Owner-authenticated linked-repair route with a typed P2 body; capture Repair Run and link atomically |
| Workspace separation | Physical-root canonicalization and overlap checks, including launch boundary | P2 needed to preserve checks during initiation, recovery and resumption | Reuse the checks at admission, launch, recovery and outcome/resume gates |
| Repair settlement | Existing success marks `repair_completed` | Success alone is not logical authorization | Accept only the named Agent/Text output whose text artifact SHA-256 matches the persisted expected digest |
| Parent resume | Existing path retries node and changes Parent to running | No exact outcome gate, safe retry flag, or P2 resume CAS | Persist `failed_node_retry`; CAS accepted link to `resumed`, then create the retry attempt and journal event in one transaction |
| Engine recovery | P1 rejects all linked Runs | A blanket exclusion prevents P2 recovery; relaxing it broadly would weaken P1.5 | Exempt only `logical_policy` links that pass the existing published-definition, execution-class, workspace, Custody, and uncertainty gates |
| Authorization | Public-class route still requires Runtime Owner credential; Host credential cannot call it | No typed control request for logical authorization | Persist the trusted Owner control request as an authorization artifact; normal provider output has no authority to create a link |
| Publication identity | Runs capture immutable publication IDs/digests | P2 must bind and recheck both Runs after restart | Authorization/checkpoint artifacts pin Parent and Repair publication IDs, snapshot digests, and run IDs; fail closed if any binding changes |

## 4. Durable model and invariants

Migration [m19.sql](../storage/m19.sql) extends the existing `run_links` row. It stores the incident ID, Parent and Repair Run IDs, both workspace IDs, Parent checkpoint artifact, exact Repair result node and SHA-256, explicit retry policy, continuation contract, Repair outcome, decision status, and Parent suspension/resumption state. `authorization_artifact_id` stores the trusted request and pinned publication identities. The checkpoint artifact stores the failed-node attempt identity/state and accepted Parent attempt IDs/output artifacts.

The request, captured Repair Run, checkpoint, authorization artifact, link, journal events, and idempotency receipt commit in the same SQLite transaction. `repair_run_id` is unique; `incident_id` is unique; a partial unique index allows only one active link per Parent. Existing lifecycle links migrate with `continuation_contract='lifecycle'` and `incident_id=NULL`; migration does not invent P2 incident identities for historical rows.

Repair terminal state and logical outcome acceptance commit together. Parent resumption uses a compare-and-set from `repair_accepted`, and the state change, retry-attempt creation, Run transition, and `continuation.parent_resumed` event share one transaction. A retry refusal rolls back that transaction and moves the link to `blocked` with a durable blocked event. Repeat reconciliation is inert after the link leaves its source state.

The Parent remains the same Run and immutable publication. Repair remains a different Run on its own immutable publication. A newer Draft or Published Version does not change either captured Run.

## 5. State transitions

Normal path:

```text
Parent: running/waiting_for_user
  → suspension_requested (if an attempt is active)
  → suspended_for_repair
  → resumable (exact result accepted)
  → resumed (same Run ID; optional explicitly safe retry)
  → running → succeeded/failed/canceled

Repair: queued → running → succeeded
  → repair_accepted (only if result artifact digest matches)
```

Negative paths:

```text
Repair failed/canceled/interrupted or result digest mismatch
  → repair_failed / rejected; Parent stays suspended

Accepted result + retry policy never, or uncertain Parent attempt
  → blocked; Parent does not dispatch

Owner stops Parent during Repair
  → parent_stopped; queued/running Repair is stopped; no Parent resume

Broken publication binding or workspace isolation
  → fail closed; no Repair launch or Parent continuation
```

The Parent base Run state is not overloaded with a new enum. A P2 Parent can remain `running` while its active attempt settles, or `waiting_for_user` after the failed node, while the separate link says whether it is suspended for Repair. `pumpRun` checks the durable link before dispatch, lets already-active work settle, and holds new node dispatch until the link is `resumed`.

## 6. Repair initiation, authorization, and logical outcome

The P2 request uses the existing Owner-authenticated `POST /api/v2/runs/{id}/linked-repair` route. It names an incident UUID, failed Parent node, exact Repair workflow snapshot, separate registered workspace, result node, expected text-artifact SHA-256, and either `explicit_safe` or `never` for retrying the failed Parent node. Host credentials cannot authorize this Owner operation. No provider prompt receives the Owner credential.

The Engine validates the captured Parent and exact runnable Repair publication; it rejects unsupported execution classes, missing result nodes, workspace overlap, missing publication, and unsafe Parent attempt states. Repair result acceptance is separate from lifecycle activation: the P2 route does not create a lifecycle operation and does not grant protected Host authority.

The response identifies the link, incident, Parent and Repair IDs, current states, decision, and workspace ID. After initiation, the existing Run journal carries typed suspension, accepted/rejected result, blocked-resume, and resumed events. No new unauthenticated coordination read route was added.

## 7. Workspace and Process Custody safety

Admission and every Repair process launch compare canonical effective filesystem roots, not workspace IDs or string prefixes. The same guard runs during recovery and before accepting/resuming a result. Parent and Repair use separate roots. Existing Custody workspace holds continue to prevent a conflicting Run until the Host proves the process tree ended; Parent resume also waits for any held Parent attempt.

The Host-backed fixture uses the actual Rust Lifecycle Host and Rust provider CLI. P2 does not introduce its own process owner or bypass `runner.lock`. Replacements attach a new Engine generation to the same Host, and P1 Custody reattachment retains the original Repair Attempt, Custody invocation ID, PID, and process creation identity.

## 8. Recovery ordering

The Engine acquires runtime ownership and initializes the migrated Store, attaches to Process Custody, runs P1 recovery, reattaches eligible Host attempts, then runs `reconcileContinuations()`. A P2 Parent with a durable non-resumed suspension is held while recovery runs. A P2 Repair is eligible only through its exact link and all existing P1 checks plus intact P2 authorization, immutable publications, and disjoint workspace roots. Queued Repair dispatch additionally requires Parent suspension to have settled. Reconciliation accepts completed Repair state idempotently, resumes a `repair_accepted` Parent once, and schedules the ordinary Engine pump; it does not create a second scheduler.

## 9. Published-version immutability

P2-E2E-01 publishes Parent v2 and Repair v2 while the v1 Runs are active, replaces Engine A with Engine B, and verifies that Parent and Repair retain their original `published_version_id` values and complete on v1. Missing or inconsistent publication artifacts make the P2 link ineligible for restart continuation.

## 10. Crash-boundary matrix

| Boundary | Durable behavior | Evidence |
|---|---|---|
| CB-01: suspension intent not committed | No partial link or Repair exists; retrying an unreceipted request is safe | Transaction structure; no dedicated process-kill injection |
| CB-02: suspension vs incident link | Request, incident, checkpoint, Repair Run, and journal events are one transaction | P2 initiation implementation and duplicate-request tests |
| CB-03: incident vs Repair creation | Cannot commit one without the other | Same transaction; M19 idempotency/uniqueness |
| CB-04: queued Repair before dispatch | Queued Run is durable; scheduler waits for settled Parent suspension; startup reconciliation schedules it | P2-E2E-01/02 |
| CB-05: Attempt exists but Host launch is uncertain | Existing P1 uncertainty rules prevent automatic blind replay | Reused P1 Custody recovery; not separately fault-injected for P2 |
| CB-06: Repair process active | Host invocation, spool, hold, and Attempt identity survive Engine replacement | P2-E2E-01 and P2-E2E-05 |
| CB-07: Host completes with no Engine | Host retains terminal proof/spool; replacement settles original Attempt | P2-E2E-02 and P2-E2E-04 |
| CB-08: Run terminal vs accepted outcome | Repair terminal state and accepted/rejected logical outcome share one transaction | `finishRunIfDone` and P2 settlement path |
| CB-09: accepted outcome, Parent still suspended | `repair_accepted` and `resumable` survive the injected Engine crash | P2-E2E-03 |
| CB-10: resumable before scheduler wake | Startup reconciliation sees `repair_accepted` and applies Parent resume once | P2-E2E-03 |
| CB-11: Parent resumed before next dispatch | Resume CAS, retry attempt, Run event, and journal event are atomic | P2 deterministic lifecycle and P2-E2E-03 |
| CB-12: Parent B active during another restart | Existing Custody attempt is reattached; no second invocation | P2-E2E-05 |
| CB-13: Repair failure during outage | Failure is reconciled as rejected; Parent stays waiting | P2-E2E-04 |
| CB-14: Parent Stop during Repair | Link becomes stopped and Repair Stop is requested; no resume | P2-D12 and P2-D25 |
| CB-15: Host temporarily unreachable | Existing Custody hold/unknown state keeps workspace unavailable; P2 does not weaken it | Existing P1 Host-unresolved suites; no additional P2 outage injection |
| CB-16: duplicate/stale completion | Unique incident, idempotency receipts, link-state CAS, and Engine generation fencing prevent repeated logical continuation | P2-D01 and P2-E2E-05; duplicate completion event not synthetically injected |
| CB-17: Parent Stop commits before its callback | Startup reconciliation finds the terminal Parent, marks the link stopped, and stops a still-running Repair | P2-D25; callback loss and reconciliation are covered in one live Engine, not by a second-Engine replacement |

## 11. Deterministic and Host-backed tests

Deterministic coverage is in `runtime/tests/parent-repair-coordination.test.mjs`. It covers incident replay/conflict, exact digest acceptance, mismatch rejection, failed/stopped Repair, `failedNodeRetry=never`, Parent Stop/close, missed Parent-Stop callback reconciliation with a live Repair, missing publication, overlapping workspaces, an active Parent attempt that settles before Repair starts, durable Custody hold release, transient Host cancellation during prelaunch withdrawal, Owner recovery refusal while a logical link is active, and atomic Context restoration. `runtime/tests/p2-migration.test.mjs` migrates a populated v18 lifecycle link and verifies foreign keys and legacy identity.

The Rust Host-backed E2E tests are in `runtime/tests/parent-repair-custody-e2e.test.mjs`; fixture models are in `runtime/tests/fixtures/custody-cli.rs`.

| Scenario | Result |
|---|---|
| P2-E2E-01: Engine A replaced while Repair is active; publish v2 during v1 Runs | Passed; original Parent resumes, retries safe B once, runs C once, and succeeds |
| P2-E2E-02: Host completes Repair while Engine is absent | Passed; Engine B reconciles terminal proof and resumes original Parent |
| P2-E2E-03: Engine crash after Repair acceptance and before Parent scheduling | Passed; `repair_accepted` survives and Engine C resumes Parent once |
| P2-E2E-04: Repair fails while Engine is absent | Passed; Engine B records failed Repair; Parent stays suspended |
| P2-E2E-05: two Engine replacements at distinct coordination boundaries | Passed; active Repair and then resumed Parent B each retain the same Custody invocation |

P2-D19 verifies that an accepted Repair remains pending while a durable Parent `custody_workspace_holds` row is held, then resumes only after `custodyReleaseIfEnded` receives `processTreeEnded: true`. P2-D21 injects a temporary Host outage during admission cancellation and verifies that Parent suspension remains pending and no withdrawal marker is committed until the Host returns terminal `admission_cancelled` proof. P2-D24 verifies that the `attempt.launch_withdrawn` marker and Context binding restoration commit together.

The main machine-readable proof is [2026-10-26-p2-parent-repair-e2e.json](evidence/2026-10-26-p2-parent-repair-e2e.json). It records Engine A/B and Host PIDs, Parent/Repair/incident IDs, publication IDs, Repair Attempt/Custody ID, process identity, terminal state, Host drain/spool proof, side-effect counts, and physical workspace roots.

## 12. Exactly-once boundary

P2 provides exactly-once logical incident association, idempotent Repair Run creation, idempotent outcome acceptance, and idempotent Parent resume. Accepted node results are not rescheduled. The Host-backed fixture proves one accepted A side effect, one accepted B side effect after the explicit safe retry, one C side effect, one Repair execution, and one Parent resume. It proves one Repair Host launch and reuse of the same invocation across Engine replacement.

P2 does not promise exactly-once behavior for arbitrary external APIs. An Attempt in `interrupted` or `blocked` state is treated as uncertain and cannot be automatically resumed/retried. The accepted `explicit_safe` flag is an explicit Owner decision for this incident, not a generic retry classifier.

## 13. Independent review

**Status:** Completed; no blocking findings remain. The first independent review identified four gaps: no-launch classification depended on detection-versus-reserve timing; a Parent Owner recovery call could bypass `failedNodeRetry=never`; Context binding restoration was separate from the durable withdrawal marker; and hold-release proof used only an in-memory simulation. The implementation now preserves a never-launched attempt as auditable, creates a fresh Attempt ID for Custody's single-use admission, blocks manual Parent recovery while the logical link has not resumed, checks the checkpoint's target Attempt identity until the authorized resume transition, restores Context state in the same transaction as the withdrawal event, and tests release of a durable Host hold. A further review also asked that temporary Host cancellation failure not be treated as withdrawal; the Engine now retries transient cancellation errors and keeps Parent in `suspension_requested` until the Host confirms terminal admission cancellation. The final review then found a missed Parent-Stop callback crash window; startup reconciliation now closes the link and stops a live Repair, and the reviewer confirmed the fix with no other blocking issue. D19, D21, D23, D24, and D25 cover these dispositions. The remaining review caveat is a proof-depth gap: D25 simulates a lost callback and invokes reconciliation on the same live Engine rather than replacing Engine A with Engine B while the Repair Host process is active. The core Parent→Repair→Parent lifecycle does have repeated real Engine-replacement coverage in P2-E2E-01 through P2-E2E-05.

## 14. Verification and frozen candidate

**Status:** Final-candidate verification completed. The focused P2 command passed 24/24, including all five Rust Lifecycle Host Engine-replacement scenarios. The full `npm test` run passed 839/839 tests (830 top-level subtests, including nested cases), with 0 failures, cancellations, skips, or todos; TAP elapsed time was 58m 04.917s. It started at 2026-10-26 18:23:12 UTC and finished at approximately 19:21:17 UTC. No source or test files changed during the full regression. The run emitted expected fault-injection diagnostics from passing tests (simulated ENOSPC, refused supervision arm, and Node SQLite ExperimentalWarning); these were not suite failures.

| Check | Command | Result | Exit |
|---|---|---:|---:|
| Focused P2 | `$env:DESZO_P2_WRITE_EVIDENCE='1'; node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/p2-migration.test.mjs runtime/tests/parent-repair-coordination.test.mjs runtime/tests/parent-repair-custody-e2e.test.mjs` | 24 passed, 0 failed | 0 |
| Full Node suite | `npm test` | 839 passed, 0 failed (830 top-level subtests); 58m 04.917s | 0 |
| Rust Lifecycle Host | `cargo test --manifest-path lifecycle-host/Cargo.toml` | 23 passed, 0 failed; main and doc test targets had 0 tests | 0 |
| Documentation validation | `npm run docs:check` | 31 schemas; 141 positive, 82 negative, 42 semantic negative; 1,246 local links; 67 SQL cases; 0 errors | 0 |
| Production build | `npm run build` | TypeScript and Vite succeeded; 1,763 modules transformed | 0 |
| Whitespace check | `git diff --check` | Passed; Git printed only existing LF-to-CRLF working-copy notices | 0 |

The production build retains a non-blocking Vite warning that the main minified JavaScript chunk is 691.67 kB, above the 500 kB advisory threshold. A frozen SHA-256 source inventory is recorded at [2026-10-26-p2-source-manifest.json](evidence/2026-10-26-p2-source-manifest.json). The main Host-backed proof remains [2026-10-26-p2-parent-repair-e2e.json](evidence/2026-10-26-p2-parent-repair-e2e.json).

## 15. Limitations and deferred work

- P2 resumes only sequential workflow graphs without Loop, Map, or Task nodes.
- Parent retry policy is chosen explicitly at initiation; arbitrary failure classification is deferred to P3.
- If a Host admission must be withdrawn while the Host is temporarily unavailable, P2 remains at `suspension_requested` and retries the idempotent cancellation until the Host proves the admission terminal. Repair is not dispatched during that uncertainty.
- D25 verifies a missed Parent-Stop callback and startup reconciliation with an active Host-backed Repair in one live Engine. A second-Engine replacement at that specific Parent-Stop crash boundary is not separately simulated; repeated Engine replacement is proven for the core Parent→Repair→Parent lifecycle in P2-E2E-01 through P2-E2E-05.
- P2 has no workflow-native Judge authority. P4 will need a trusted Engine-mediated decision path that does not expose Owner credentials to a provider; it can call this typed coordination contract without redesigning the durable link, scheduler gate, or recovery semantics.
- Protected Self-Repair definition and privileges are deferred to P5.
- Build activation is deferred to P6.
- Automatic Self-Repair triggering is deferred to P7.
- General workflow continuation is deferred to P8.
- Repair failure or a mismatched result leaves the Parent waiting for a later trusted decision; P2 does not invent a new human-input channel.

## 16. P3/P4 readiness

A future Judge can drive the implemented typed and durable coordination contract without redesigning Parent/Repair persistence, suspension, result settlement, or recovery. It cannot call the Owner-only route directly or receive an Owner Token. P4 must provide a trusted Engine-mediated admission that authenticates Judge authority and forwards the same typed policy fields; that is an authority adapter, not a second coordinator or scheduler.

## 17. Git state and file inventory

The working tree was clean at the start of this task, on `codex/adr-0003-0005-completion` at `40fa26a`; the two existing stashes were left untouched. All changed and new files listed here are P2-specific. Nothing was staged, committed, pushed, merged, rebased, reset, or cleaned. No hunk-level staging plan is needed because there were no pre-existing working-tree edits at task start.

P2 files:

- Production: `runtime/core/engine.mjs`, `runtime/core/linkedRepair.mjs`, `runtime/core/migrations.mjs`, `docs/storage/m19.sql`.
- Contracts: `docs/schemas/runtime-api-v2.schema.json`, `docs/schemas/journal-event-v2.schema.json`.
- Tests/fixtures: `runtime/tests/parent-repair-coordination.test.mjs`, `runtime/tests/p2-migration.test.mjs`, `runtime/tests/parent-repair-custody-e2e.test.mjs`, `runtime/tests/fixtures/custody-cli.rs`.
- Evidence: `docs/reviews/evidence/2026-10-26-p2-parent-repair-e2e.json`.
- Frozen inventory: `docs/reviews/evidence/2026-10-26-p2-source-manifest.json`.

