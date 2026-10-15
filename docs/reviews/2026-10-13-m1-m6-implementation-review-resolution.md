# M1–M6 implementation review — resolution

Date: 2026-10-13  
Review: [M1–M6 implementation review](2026-10-13-m1-m6-implementation-review.md)  
Outcome: all eight findings are corrected and have regression evidence. The [follow-up review](2026-10-13-m1-m6-resolution-followup-review.md) found that R1, R2 and R5 were not fully closed (shared Context history, delivery evidence coherence, error classification); those gaps are corrected in [its resolution](2026-10-13-m1-m6-resolution-followup-review-resolution.md). The review's own probes ([runtime probes](reproducers/2026-10-13-runtime-probes.mjs)) informed the regression tests; the probe scripts and their recorded results are kept unchanged as the historical baseline.

## Verification after the corrections

| Check | Result |
| --- | --- |
| `npm test` | 327 passed, 0 failed (previously 310). New: `integrity.test.mjs` (R3, R5, R6, R7), `reference.test.mjs` (R2), an R1 case in `revisions.test.mjs`; R8 makes the six previously unasserted semantic fixtures assert |
| `npm run docs:check` | Pass: 15 schemas, 141 positive, 82 negative schema and 39 negative semantic cases, 67 SQL cases |
| `npm run build`, `npm run runtime:bundle` | Pass |
| `cargo check --locked`, `cargo test --locked` (`src-tauri`) | Pass, including the new native Job containment test (R4) |

No real-provider run was repeated for this resolution: it consumes subscription quota and needs the user's model choice. The R5 regression reproduces the observed Antigravity event shape with a fixture.

## Findings

### R1 — approval reuse and changed instructions or native profile: fixed

The reviewer fingerprint is now a Merkle hash over the reviewing Agent's whole upstream input closure, so instructions arriving through any template slot are covered, together with `settings.nativeConfiguration`. The walk stops at the prepare Gate, whose subject-derived values the scope hash already covers. When an input cannot be established from definitions (another Agent, Loop, Map or Gate output, a workspace File Input, a Loop boundary value, a Continue Context), the fingerprint is unknown and the slot fails closed to a live review. Map task fingerprints now include the native profile as well.

- Code: `Engine.reviewerFingerprint` in [engine.mjs](../../runtime/core/engine.mjs); `taskFingerprints` in [map.mjs](../../runtime/core/map.mjs).
- Contract: [M6 contracts](../M6_CONTRACTS.md#section-and-scope-fingerprints).
- Evidence: `R1: instructions changed through a template slot, or a changed native profile, invalidate carried approvals and tasks` covers both of the review's reproductions, and also checks that unchanged instructions still carry.

### R2 — final delivery acceptance and the complete reference loop: fixed

Gate prepare gained `subject: "delivery"`. It builds the final subject only from engine evidence:
- the specification certificate, verified for the exact bundle and policy;
- the stored MapState, completed with every task of the approved map accepted;
- the stored Candidate, matching the candidate files;
- a stored CheckReport for every check criterion of the approved map, each passed with intact sources and run against that Candidate.

The final Customer prepare additionally requires a technical certificate for that exact deterministic subject. The resulting certificate carries `subjectKind: "delivery"` and `prerequisites`: the specification certificate, then the technical certificate.

The new [reference Delivery Loop](../examples/reference-delivery/workflow.json) wires the complete [delivery scenario](../TEST_PIPELINE.md#delivery-loop-wiring):
- verify and bypass, or the Specification Loop (whose Analyst also authors the map);
- the Map with its prior-state and repair inputs;
- quality and conformance review under a technical Gate, then final Customer acceptance;
- on rejection, Analyst triage: either a MapRepair built from the rejecting Gate's issues, or a specification revision;
- return through the Loop until final acceptance is recorded.

Carried task selections now keep their criterion evidence, so a carried task still proves its checks at final review.

- Code: `prepareDelivery` and `certificateFor` in [gate.mjs](../../runtime/core/gate.mjs); MapState criteria in [mapRuntime.mjs](../../runtime/core/mapRuntime.mjs).
- Contract: [M5 final delivery acceptance](../M5_CONTRACTS.md#final-delivery-acceptance).
- Evidence: `reference.test.mjs` covers two paths.
  - Customer rejection → triage → targeted task repair. The next iteration bypasses documentation, carries three independent tasks and is accepted.
  - Specification triage → revision. All documentation reviewers re-review, unchanged tasks carry, and the delivery is accepted.
  - In both, the success-path failure join and triage stay inactive, and the final certificate's prerequisites are checked.

### R3 — capture/storage failure crashing the runtime: fixed

Stream callbacks, the spawn handler, end-of-stream handling and LogBatch timers no longer let storage errors escape. A failure stops the owned process tree, and the attempt fails with the new code `capture_failed` (journal v2, additive), distinct from timeouts and provider failures. If even the journal cannot be written, the runtime blocks new work (run creation returns 409), stops its owned processes and stays up; restart recovery handles the affected runs.

- Code: `captureFault`, `storageUnavailable` and `LogBatch` in [engine.mjs](../../runtime/core/engine.mjs).
- Contract: [M1 output capture integrity](../M1_CONTRACTS.md#output-capture-integrity).
- Evidence: the R3 test injects `ENOSPC` exactly as the review's probe did. It also covers the journal-unavailable case.

### R4 — no supervision of unexpected Node exit: fixed

A supervisor thread watches each runtime generation, independently of UI calls. On unexpected Node exit it terminates the Job, waits until the Job reports no active process, and emits `runtime-lost`. The window then reconnects to a new generation, and it also reconnects when its event stream fails. A failed Job query or termination is now uncertainty, never "no processes": Rust refuses a new generation and asks the user to close the app, which closes the Job handle.

- Code: [main.rs](../../src-tauri/src/main.rs); `connect` in [App.tsx](../../src/App.tsx).
- Contract: [M1 process containment](../M1_CONTRACTS.md#process-containment).
- Evidence: the native test `descendants_survive_the_direct_child_until_the_job_is_drained` kills the direct child, shows that its descendant is still running inside the Job, then shows `terminate_and_wait` drains it. A full desktop crash of the packaged app was not exercised.

### R5 — Antigravity publishing a stale structured output: fixed

Normalization now follows the current output contract:
- **Text Agents** publish the turn's text response.
- **JSON Agents** use a provider's structured field only when it belongs to the current turn (Claude's result event), or when the turn has no textual response.
- **Conflicts:** a conflicting structured value is rejected as `output_contract` instead of being published.

- Code: `selectFinal` and `createParser(provider, { output })` in [adapters.mjs](../../runtime/core/adapters.mjs).
- Evidence: the R5 unit test covers selection, and the R5 run test reproduces the review's event shape. The text run commits `ORBIT\n`; the ambiguous JSON run fails into recovery.

### R6 — split UTF-8 characters: fixed

Output is decoded with a streaming UTF-8 decoder, flushed at end of file. Evidence: the R6 test splits an emoji across writes and also includes Cyrillic text; the output round-trips exactly.

### R7 — migration DDL and version record not atomic: fixed

`Store.migrate` now applies each script's statements and its `schema_migrations` row in one transaction; the runtime supplies the transaction and pragma boundaries itself. A failure rolls back and reports the unchanged version, so a newer schema can no longer end up without its version record.

- Contract: [storage](../STORAGE.md).
- Evidence: the R7 test injects a failure at the end of migration 2. The store stays at version 1 with no partial tables, then migrates fully on the next open.

### R8 — semantic fixtures passing without assertions: fixed

`map` and `sections` fixtures now run through the runtime validators. The new `sectionIssues` function mirrors the docs oracle, and `mapIssues` accepts the role fixture registry. An unknown semantic validator now fails its test instead of passing. All six named cases assert their expected codes and pass.

## Documentation status cleanup

- [Milestones](../MILESTONES.md): the header now records delivery rather than a proposal, the contract table no longer calls the M3–M6 schemas pending, and the M5 entry cites the reference-loop evidence.
- [README](../../README.md): states what the automated evidence covers, and that a real-provider run of the full M4–M6 pipeline, installer packaging and long-running load remain unverified.
- The Vite chunk-size warning is still an optimization item, as the review noted.

## Remaining limits

- No real-provider run of the full M4–M6 coding pipeline was made; the fixture agents prove orchestration, not model capability.
- The native containment test exercises the Job logic directly. A crash of the packaged Tauri application with live CLI descendants, installation and long-running load were not tested.
