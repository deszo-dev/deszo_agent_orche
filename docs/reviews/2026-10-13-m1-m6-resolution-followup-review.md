# M1–M6 resolution follow-up review

Date: 2026-10-13  
Reviewed: [implementation review resolution](2026-10-13-m1-m6-implementation-review-resolution.md)  
Verdict: **the implementation improved substantially, but the claim that all eight findings are fully closed is premature. Two P1 gaps and one P2 error-classification defect remain.**

This review independently re-ran the checks and inspected the changed code. It also exercised cases beyond the newly added regressions. No real provider calls were made and no production source or existing documentation was edited. The new probes and recorded results live under `docs/reviews/reproducers/`.

## Verification

| Check | Result |
| --- | --- |
| `npm.cmd test` | 327 passed, 0 failed, 0 skipped; approximately 183 seconds |
| `npm.cmd run docs:check` before adding this report | Passed: 15 schemas, 141 positive schema cases, 82 negative schema cases, 39 negative semantic cases, 381 links, 67 SQL cases |
| `npm.cmd run build` | Passed: TypeScript and Vite; main chunk 651.28 KB, with the existing size warning |
| `npm.cmd run runtime:bundle` | Passed |
| `cargo check --locked` | Passed |
| `cargo test --locked` | Passed: one native Windows Job test |
| `npm.cmd run desktop:build` | Passed: optimized Windows `deszo.exe` rebuilt from the current source; this uses `--no-bundle` and does not verify an installer |
| Independent fixture probes | Reproduced the three remaining defects below; [results](reproducers/2026-10-13-resolution-followup-results.json) |

The two new reference-loop tests passed: final Customer rejection causes a task repair followed by acceptance, and specification triage causes a reviewed revision followed by acceptance. The success branch keeps failure triage inactive. This is a real improvement over the previous implementation, which ended at Map completion.

## Remaining findings

### F1 — P1: changed history in a shared New Context still reuses an old approval

Location: [engine.mjs](../../runtime/core/engine.mjs), `reviewerFingerprint`, lines 992–1015.

The new fingerprint covers data-edge producers and the Context definition. It does not cover order-only dependencies or the other Agents that write to the same native Context before the reviewer. A Context with `mode: "new"` is created once per run, not once per Agent: a prior writer can already have changed its history when the reviewer is invoked.

**Reproduction:** start from the selective-review example, retain the documentation-review portion, and add a Codex Context shared by a `memory-writer` and `customer-review`. An After dependency orders the writer before the reviewer. In the first run the writer is instructed to remember policy A, and the Customer approves. In the second run the writer's Text changes to policy B, explicitly requesting rejection, while the prior approval is supplied.

Observed in the second run:

- `memory-writer`: Succeeded, with the changed instruction;
- `customer-review`: Skipped;
- Customer review plan: `status: "current"`, `needsReview: false`.

The reviewer's potential native history changed, but its fingerprint did not. The original R1 template-slot and native-profile reproductions now pass; this shared-history case remains unsafe.

**Required correction:** include relevant After dependencies and shared-Context writers in the review dependency proof. When the history preceding a review cannot be established, force a live review. Merely hashing `context.config` does not prove the native conversation state. Keep the current ability to carry an unchanged review with a provably unchanged independent input.

Evidence: `R1-shared-New-Context-history` in the [results](reproducers/2026-10-13-resolution-followup-results.json). The fixture establishes the scheduling/fingerprint failure; it does not claim a real model would necessarily reject policy B.

### F2 — P1: delivery preparation accepts unrelated MapState and candidate/check evidence

Location: [gate.mjs](../../runtime/core/gate.mjs), `prepareDelivery`, lines 302–317.

The Gate verifies that every supplied reference is an engine record, but it does not establish that those records form one coherent selected implementation. It checks MapState task acceptance, then independently accepts the Candidate and CheckReports from the caller-supplied summary. It does not tie the Candidate to the MapState's selected verification TaskResult, or the CheckReports to that state's accepted criterion evidence and selected task-result sources.

**Reproduction:** execute two complete Maps for the same approved specification. For the second run, a fixture-only preload adds a harmless comment to the implementation source, so the two accepted candidates have different byte hashes. Both runs execute actual checks and complete successfully.

Then create a summary containing:

- MapState and selected results from run B;
- Candidate and passing CheckReports from run A;
- candidate files from run A.

Every reference is genuine. `prepareDelivery` accepts this mixed summary and prepares a final review subject, although MapState B selected Candidate B. The recorded results contain both distinct candidate hashes and record IDs.

This allows a stale candidate to be presented as the implementation selected by another Map. Engine ownership of each record is necessary, but does not establish the relationship between those records. Normal reference-loop tests pass because their wiring supplies a coherent summary; they do not test inconsistent evidence.

**Required correction:** derive or validate final evidence through the stored MapState, its selected TaskResults, and their recorded criterion proofs. Verify the Candidate against the selected verification result and each CheckReport against the selected source and approved check definition. Avoid a blanket same-run restriction: legitimate carried selections use earlier records, and should remain valid when their selection/source relationships are proved.

Evidence: `R2-mixed-MapState-and-candidate-evidence` in the [results](reproducers/2026-10-13-resolution-followup-results.json): `expectedAccepted: false`, `actualAccepted: true`. The probe calls the actual Gate implementation with normal typed inputs and engine-issued records; it does not forge an engine record or alter the database's trusted projections.

### F3 — P2: ambiguous Antigravity output is classified as a process failure

Location: [adapters.mjs](../../runtime/core/adapters.mjs), lines 150–160 and 189–191; [engine.mjs](../../runtime/core/engine.mjs), lines 1403–1406.

The stale text-result defect itself is fixed: the regression commits the current `ORBIT\n` response. For an ambiguous JSON result, however, `selectFinal` stores its format error in `parser.state.error`. The engine subsequently sends that message through provider failure classification, producing `attempt.error.code: "process"`.

**Reproduction:** run the existing `antigravity-stale` stream fixture with JSON output. The run correctly pauses and publishes no answer, but its durable journal reports `process`, while the resolution and contract promise `output_contract`.

**Required correction:** carry the normalization error class to the engine and journal it as `output_contract`. Add an assertion for the error code, not only `waiting_for_user`. This is smaller than F1/F2, and does not reintroduce publication of the stale result.

Evidence: `R5-error-classification` in the [results](reproducers/2026-10-13-resolution-followup-results.json).

## Status of the original findings

| Original finding | Follow-up assessment |
| --- | --- |
| R1 — approval reuse | Template-slot/native-profile changes are covered; shared native history still escapes the proof (F1) |
| R2 — complete delivery | Reference Loop, final reviews, Customer acceptance, repair/revision and prerequisites exist and pass; final evidence consistency remains incomplete (F2) |
| R3 — capture failure | Original failure is contained; both capture failure and unwritable-journal regressions passed |
| R4 — native supervision | Independent generation watcher and fail-closed Job errors are implemented; native Job test passed. Packaged-app crash recovery remains unverified |
| R5 — stale structured result | Current text selection is fixed; ambiguous JSON error classification still differs from the contract (F3) |
| R6 — UTF-8 | Streaming decoder and split emoji/Cyrillic regression passed |
| R7 — migration atomicity | DDL and version insertion share a transaction; rollback regression passed |
| R8 — assertion-free fixtures | All six originally named semantic cases now invoke runtime validators and assert their expected codes |

The new MapState criterion evidence is useful and necessary for carried tasks. F2 should consume that evidence as the authoritative selection proof, rather than only trusting separate references in a mutable summary.

## Reproduction and limits

Run the quota-free probes with:

```powershell
node --disable-warning=ExperimentalWarning docs/reviews/reproducers/2026-10-13-resolution-followup-probes.mjs
```

They use isolated fixture stores under `.deszo/tests`, write the [JSON results](reproducers/2026-10-13-resolution-followup-results.json), and leave existing source unchanged. The [source variation preload](reproducers/2026-10-13-resolution-code-variant.mjs) is used only inside the fixture CLI for the second Map; it adds a comment to copied task output and does not bypass checks or alter accepted engine records.

The following remain unverified, as the resolution states: a real-provider full coding pipeline, a packaged Tauri crash with live CLI descendants, installer packaging, and long-running load. The passing fixtures and direct Job test should be described with those limits. They do not require repeating paid model calls to correct F1–F3.

Acceptance recommendation: close the original UTF-8, migration, capture and assertion defects; retain the new complete reference workflow and supervisor. Complete the shared-history approval proof and the Map/candidate/check relationship checks before accepting M6 reuse and final delivery certificates as reliable.
