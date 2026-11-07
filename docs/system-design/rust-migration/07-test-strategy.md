# 07. Test strategy

## 1. Principles

- Tests are mapped by **contract**, not by file name: existing Node test → the contract it protects → the Rust test that protects the same contract at the right level.
- The Node suite (113 files, 783 top-level cases, more than 1,000 cases with subtests; 995/995 on the G0 snapshot) defines expected behavior. Its passing results say nothing about the Rust implementation.
- No contract is weakened to make the migration look complete. A Rust test that cannot reproduce a recorded behavior is a defect or an explicit, recorded behavior change with its reason.
- Levels: **unit** (crate-internal, `cargo test`), **integration** (Engine against a fake Host, or Host against a skeleton Engine, in-process or with real pipes), **system** (packaged Host, Shell and Engine on a test profile), **genuine E2E** (A → B → C).

## 2. Contract map

| Contract family | Existing Node tests (examples) | Rust level and location |
|---|---|---|
| Workflow contracts, schemas, validation | `contracts.test.mjs`, `integrity.test.mjs`, `context-contracts.test.mjs`, `effort.test.mjs` | Unit in `deszo-workflow`, `deszo-protocol`; fixture cases from `docs/fixtures` |
| Published workflow immutability, drafts, publications | `authoring.test.mjs`, `p34-publication.test.mjs`, `revisions.test.mjs`, `ui-authoring-transport.test.mjs` | Integration in `deszo-engine` (API level); differential (§3) |
| Run pinning and capture | `engine.test.mjs`, `run-scoped-identity.test.mjs`, `workflow-p1-published-and-ordinary.test.mjs` | Integration; differential journals |
| Scheduler, Loop, Map, Task, review Gate | `loops.test.mjs`, `map.test.mjs`, `managed-task.test.mjs`, `pipeline.test.mjs`, `reference.test.mjs`, `task-assessment.test.mjs` | Unit for pure transitions (`m2Transition`, `loopStep`, `routeCase` equivalents); integration with fixture providers |
| Progress-driven continuation, no termination on silence | `workflow-continuation*.test.mjs`, `workflow-p1-*.test.mjs`, `followup.test.mjs` | Integration with time-controlled fixture providers |
| Judge authority and Owner questions | `workflow-judge-policy.test.mjs`, `workflow-judge-runtime.test.mjs`, `workflow-judge-scenarios.test.mjs`, `judge-control.test.mjs`, `judge-recovery.test.mjs` | Unit for decision application; integration for question routing; Host unit tests for acceptance decision parsing |
| P2 Repair | `parent-repair-coordination.test.mjs`, `linked-repair-isolation.test.mjs`, `p2-migration.test.mjs`, `parent-repair-custody-e2e.test.mjs` | Engine integration against a fake Admission |
| Failure outcomes | `failure-outcomes.test.mjs` | Unit |
| Provider adapters | `codex-adapter.test.mjs`, `antigravity*.test.mjs` | Unit on recorded native streams |
| Custody and fencing | `process-custody.test.mjs`, `custody-*.test.mjs`, `p6-g0-custody-e2e.test.mjs` | Host unit (existing Rust tests) and system tests |
| Crash and restart recovery | `engine-startup.test.mjs`, `restart-control.test.mjs`, `p6-g0-recovery.test.mjs`, `p6-g0-c09.test.mjs`, `runner-lock.test.mjs` | Engine integration (Store recovery); Host system tests (G0 recovery) |
| Host switching (G0) | `p6-g0-switch.test.mjs`, `p6-g0-c02-c13.test.mjs`, `p6-g0-m1-commit-order.test.mjs`, `p6-g0-identity.test.mjs`, `p6-g0-admission*.test.mjs`, `rust-host-lifecycle.test.mjs`, `tauri-host-proof-b.test.mjs` | Host system tests, re-pointed to the Host-internal trigger |
| Protected P5 | `protected-self-repair.test.mjs`, `p5-verifier.test.mjs`, `p5-e2e.test.mjs`, `p6-gate-negatives.test.mjs` | Host Admission integration with fixture candidates |
| Workspace isolation and slot pool | `p5-workspace-pool.test.mjs`, `p5-workspace-alias.test.mjs`, `p5-workspace-reserved-run.test.mjs`, `p6-s2d-duplicate-claim.test.mjs` | Host slot-pool unit tests; Engine ordinary-run reservation tests |
| Git source identity | `p5-native-source-identity.test.mjs`, `p5-crlf-identity.test.mjs`, `p5-managed-clone.test.mjs` | Host identity unit tests with object vectors; Engine `deszo-git` integration |
| Candidate scope and trusted build | `p6-builder-boundary.test.mjs`, `p6-build-unit.test.mjs`, `p6-build-integration.test.mjs`, `desktop-build-*.test.mjs` | Host policy unit tests; build-job integration; reproducibility test |
| P6 acceptance and continuation | `p6-successor-identity.test.mjs`, `p6-build-e2e.test.mjs` | Host successor-enrollment unit tests; system test |
| A → B → C and exhaustion | `p6-genuine-e2e.test.mjs` | Genuine E2E (§6) |
| API permissions and Owner Token | `amd19-authorization.test.mjs`, `controller-tools.test.mjs`, `bridge.test.mjs`, `run-observer.test.mjs`, `supervision.test.mjs` | Gateway integration; MCP contract tests |
| Legacy Control Host and ADR-0006 | `adr6-*.test.mjs`, `control-host*.test.mjs` | Retired with OD-5; replaced by one test that the autonomy routes answer unavailable |
| Test infrastructure | `test-roots.test.mjs`, `release.test.mjs` | `xtask` and harness tests |

M0 produces the complete table with every file and the contract IDs it covers. A file whose contract has no Rust row blocks M10.

## 3. Differential verification

The same scenario runs through the Node Engine and the Rust Engine on two copies of one fixture profile, with the same fixture provider responses (`runtime/tests/fixture-cli.mjs` scenarios, recorded and replayed by `deszo-testkit`). Compared after normalizing identifiers, timestamps and process ids:

- persistent state: rows of the run, attempt, journal, receipt and publication tables; artifact digests;
- journal event sequences and payloads;
- API responses, status codes and ETags for the route inventory;
- lifecycle transitions on the Host side;
- refusal codes for invalid requests.

Implementation details that do not form a contract (internal ordering of unrelated events in one commit, log text, timing) are excluded by an explicit normalization list. Every exclusion is listed with its reason, so the comparison does not silently widen.

## 4. Golden vectors

- Canonical JSON: every object in the M0 profile copy, plus generated cases for key ordering beyond the Basic Multilingual Plane and number formatting (05 §2.1).
- Git object identity: commits, trees and blobs for both object formats in use, including the line-ending cases from the P5 CRLF tests.
- Migration digests: the 22 scripts and their `schema_migrations` rows.
- Provider streams: recorded native output for each provider and output contract.

## 5. Security and refusal tests

These are regression tests of the boundary, written as assertions that something is refused or absent. They do not attempt to obtain credentials or reproduce earlier bypasses; they check that the design's controls hold. Each row names the milestone that first has the functionality.

| Property | Test | Milestone |
|---|---|---|
| The Engine channel has no privileged verb | The protocol's Engine-to-Host enum has no stage, switch, fence, attach, acceptance, build, enrollment or binding variant (compile-time list test); unknown, misdirected or wrong-phase frames are refused; maintenance messages from a normal Engine and normal messages from a maintenance Engine are refused | M4 |
| No legacy entry point | No child-reachable loopback listener or `custody-serve` dispatch exists in the packaged Host | M4 |
| Owner Token placement | The token is absent from the Engine's bootstrap, environment, pipe traffic and grants; forwarded requests carry the principal, not the bearer | M4 |
| Containment grants | Each principal's profile has exactly the grants of 02 §7 and 13; the PR-1, PR-5 and PR-8 scenarios run as packaged system tests on every release candidate | M4 |
| Run scopes | Scope issue refuses roots overlapping Host state, the Store or claimed slots; two concurrent Runs are mutually denied; an Engine-supplied extra root is refused; a scope request for a Run with no witnessed start or recorded derivation stays pending and custody refuses its launches; a child scope is never wider than its parent's; a publish whose snapshot `resources` differ from the witnessed draft gets no scope; unconfirmed legacy workspaces and publications get none; revocation applies at the next launch | M4, M5 |
| Protected Parent and authorization | Refusal of: a Run not registered by the gateway; a Parent Judge checkpoint at the wrong node or a reused attempt; a failed custody record of another registration, of another node than the profile's failed node, or of a utility job; a second authorization for one registration; a checkpoint after the Parent Judge budget is spent; `request_repair` for an unpinned profile; an incident that does not reproduce on the baseline (`p5_incident_not_reproduced`); a second claim with one authorization or a claim of another generation's slot; a claim after an Owner Stop of the Parent; a cross-publication Repair registration; an authorization from an earlier generation | M7 |
| Checkpoint sequencing | Gate and acceptance checkpoints refused at a wrong node, a reused attempt, an unsealed or different snapshot, or before a passed verification; any checkpoint after a failed Gate or a `reject_repair` under the same authorization is refused; an `accept_repair` without delivery of the complete required review set is refused; sealing refused while a slot job is active; `wait`, `request_evidence` and budget exhaustion behave as the workflow Judge does today | M7 |
| Causal outcome classes | The harness refuses incomplete scenarios, skipped or missing assertions, crashes, timeouts, wrong failure class, and a baseline or candidate build failure | M7 |
| Identity and policy | Each rule of 04 §3.2 has a refusing fixture; a commit whose parent is not the seed is refused; replacement refs and alternates are ignored | M7 |
| Protected Owner actions | Answers refused when stale, superseded, malformed, schema-invalid, with a wrong subject digest, or replayed with a different payload; an exact replay returns the recorded receipt; `AnswerArrived` reaches the waiting Judge node; a run-level protected Stop is journaled before forwarding and invalidates the chain even if the Engine refuses it; a node Stop does not invalidate; an admission Stop from the Host view invalidates regardless of the Run ids the Engine registered | M7 |
| Build and package | Altered intent, substituted or linked output, extra or missing package file, mismatched digests and a stale receipt are refused; the build ID equals the intent-derived value | M8 |
| Eligibility cutoff | A Stop or invalidation journaled before `eligibility_cutoff` blocks the switch; one after it does not; the Engine's `ReportInvalidation` duties match today's `p5Eligibility` results in a parity test; every interleaving in a scripted race test | M8 |
| Successor | The last free slot can be claimed, and the P6 operation then refuses with `p6_successor_workspace_exhausted` before any build or stage; a failed seed refuses before any build | M8 |
| Preflight B | Before commit, B is denied the live Store; after commit and the grant transition, B runs normally; a failed transition holds | M8 |
| Recovery | Host crash at each journal boundary (04 §9) resumes or holds as specified; duplicate deliveries consume once; abandoned evidence is never reused | M7, M8 |
| Host reliability | A stalled job reader, an oversized export, a saturated bulk lane and an injected Admission panic leave lifecycle, Stop and custody control responsive | M7 |
| Release manifests | A manifest declaring the `test-seams` feature is refused | M4 |
| Profile lock | A Node runner and a Rust Engine cannot own the same profile at once | M3 |
| Cutover | The old bearer is refused after cutover; UI and MCP rediscover; only Owner-confirmed workspaces and publications receive scopes; journaled access-control entries are reversed by a pre-commit restore; a profile without enrollment cuts over with admission closed | M9 |

## 6. Genuine end-to-end

- **A → B → C:** a packaged installation (M4 test packages) with three slots; two Parent incidents started by the Owner through the gateway; for each, the Host-launched Parent Judge authorizes a Repair, the Repair claims its slot, the Gate and acceptance checkpoints run at their nodes, the Host builds, seeds the successor slot, stages and commits; no Owner request other than the incident starts, protected-question answers if the fixture asks one, and reads occurs between the root enrollment and C's verification (the Owner-action window trace of `p6-genuine-e2e.test.mjs` is kept); no Git push occurs.
- **Exhaustion:** two slots; the first Repair activates B; B's Repair claims the second slot and is accepted; its P6 operation refuses before build or stage.
- **Restart:** the chain is repeated with a Host restart injected at `switch_prepared` and after the selector write, and an Engine restart during a Repair; the chain completes exactly once.
- **Refusal paths:** one run each refused at authorization, policy, causal verification and the acceptance Judge, with the Parent continuing per its captured retry rule.
- Developer, Judge and Parent worker responses are fixture providers, stated in the evidence. A real-provider rehearsal is an Owner-run step because it consumes quota.

## 7. Tiers and cost

- `cargo test --workspace` for unit tests on every change.
- Integration tests in a separate set, with real pipes.
- System and genuine E2E tests in `xtask` against packaged test builds, holding the existing test gate (one gated run at a time, `scripts/run-tests.mjs` rule kept).
- The full regression before a release freeze. No duration is claimed: packaged tests are dominated by process starts, containment setup and Cargo builds inside verification jobs, and their cost is measured in M4 and M8 (08 §5).
