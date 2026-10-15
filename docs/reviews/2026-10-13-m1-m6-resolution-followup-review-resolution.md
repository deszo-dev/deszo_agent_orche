# M1–M6 resolution follow-up review — resolution

Date: 2026-10-13  
Review: [resolution follow-up review](2026-10-13-m1-m6-resolution-followup-review.md)  
Outcome: F1, F2 and F3 are corrected. Each has a regression test adapted from the review's [probes](reproducers/2026-10-13-resolution-followup-probes.mjs); the probe scripts and their recorded results are kept unchanged as the baseline.

## Verification after the corrections

| Check | Result |
| --- | --- |
| `npm test` | 330 passed, 0 failed (previously 327), including the new `runtime/tests/followup.test.mjs` (F1, F2, F3) |
| `npm run docs:check` | Pass |
| `npm run build`, `npm run runtime:bundle`, `cargo check --locked`, `cargo test --locked` | Pass |

No real provider was called.

## F1 — shared New Context history: fixed

The reviewer fingerprint now also covers every After prerequisite of the nodes in the reviewer's dependency closure. If any other Agent or Map role writes the reviewer's Context, the fingerprint is unknown and the slot runs live, because a writer that ran earlier in the run may have changed the native history the reviewer resumes. Hashing the Context definition alone proves nothing about that history. A reviewer whose inputs are provably unchanged and independent still carries. The fingerprint version was raised, so approvals recorded under the earlier definition no longer match and are reviewed live once.

- Code: `Engine.reviewerFingerprint` in [engine.mjs](../../runtime/core/engine.mjs).
- Contract: [M6 reviewer fingerprint](../M6_CONTRACTS.md#section-and-scope-fingerprints).
- Evidence: the review's shared-Context reproduction, the `F1` test.
  - The Customer review now runs live with `reviewerFingerprint: null`.
  - The independent readiness review stays `current` and is skipped.

## F2 — unrelated MapState and candidate/check evidence: fixed

`prepareDelivery` now derives all final evidence from the stored MapState and checks the summary against it, instead of accepting the summary's separate references:
- **Selections:** every task's selected TaskResult must be stored and belong to that task. The MapState must record each accepted task's criterion evidence (states without it are refused rather than guessed). The summary's selected results must equal these selections.
- **Candidate:** it must be the one recorded in the selected verification TaskResult, assembled from exactly the selected dependency results. The summary's candidate and the candidate files must be that record and its manifest.
- **Checks:** each check criterion's CheckReport is the one named in the MapState's criterion evidence. It must have passed with intact sources and run the approved command: arguments, timeout, required exit and source kind. It must also have checked the selected Candidate, or the task's own selected result.

Carried selections remain valid: their criterion evidence travels with the MapState, so their earlier records are accepted because these relationships hold, without any same-run restriction.

- Code: `prepareDelivery` in [gate.mjs](../../runtime/core/gate.mjs).
- Contract: [M5 final delivery acceptance](../M5_CONTRACTS.md#final-delivery-acceptance).
- Evidence: the review's two-Map reproduction, the `F2` test. Mixing MapState B with Candidate and checks A is rejected. So are candidate files from another Map and a mismatched selection list. The coherent summary is accepted, and the reference Delivery Loop tests (which include carried selections) still pass.

## F3 — ambiguous output classified as a process failure: fixed

The parser now reports output-contract violations separately (`formatError`) from provider and process failures (`error`). The engine journals such a violation as `output_contract` with its message. The stale value is still never published.

- Code: [adapters.mjs](../../runtime/core/adapters.mjs), [engine.mjs](../../runtime/core/engine.mjs).
- Evidence: the `F3` test asserts the journaled code `output_contract`, not just the waiting state.

## Remaining limits

These are unchanged and still unverified: a real-provider run of the full coding pipeline, a crash of the packaged Tauri app with live CLI descendants, installer packaging, and long-running load.
