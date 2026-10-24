# Antigravity structured-output correction — 2026-10-21

The user authorized direct implementation outside the Fixer workflow, including the adapter that had previously been held unchanged. This change does not enable autonomy or close any ADR acceptance gate.

## Observed failure

The original Watcher used Antigravity CLI 1.4.2 with `gemini-3.8-flash-high` and explicit effort `high`. Its `finish` call contained `attemptedApproaches: null` and `issueSummary: null`; the native tool required an array and a string. The CLI rejected the call, the model repeated the malformed response, and the engine's 300-second deadline expired. No terminal `result` was captured. This was not a valid completed verdict followed by a demonstrated CLI hang.

The shared output-contract instructions emphasized nullable fields for merged alternatives without clearly distinguishing required non-nullable fields. The provider parser also discarded the native tool error from its normalized output. CLI and engine deadlines were both 300 seconds.

## Change

- Output instructions now require each mandatory field's declared type, permit empty strings/arrays where the contract permits them, and restrict null to fields whose native schema allows it. The instructions require correcting a rejected `finish` object before retrying. Full contract validation remains unchanged; null is never silently converted into an empty value.
- Native tool errors become bounded, deduplicated diagnostics in normalized capture and failure evidence. They remain recoverable: a later valid terminal result can succeed. A tool step or partial response still cannot establish completion.
- Antigravity's print deadline reserves exit time within the unchanged engine budget: a 300-second attempt uses a 270-second CLI limit. The reserve is capped at 30 seconds and reduced for short attempts; it is not an extension of aggregate or process bounds.
- Adapter version advances to 3 because invocation/prompt semantics changed. Existing Context compatibility checks will refuse bindings from the previous version; no old history is silently reused under new instructions.

## Verification

Six regression tests cover deadline separation, observable/recoverable finish rejection, bounded diagnostic retention, timeout evidence, successful correction and rejection of a terminal schema-invalid reply. Existing transport tests still cover nullable alternative decoding and ambiguous/stale structured output.

Replaying all 65 records of the original failed invocation produces no final answer in either version. The old parser exposes no diagnostic; the corrected parser retains the exact two-field `finish` error. This replay makes zero model calls.

Two standalone real CLI checks used the configured Watcher model and effort, fresh sessions and an isolated temporary directory. No Deszo runtime or workflow was started:

| Check | Exit | Terminal result | Full schema | Duration |
| --- | --- | --- | --- | --- |
| Original task/template and saved Developer report, with corrected output instructions | 0 | SUCCESS | Passed | 69.324 s |
| No issues or approaches: required empty string and array | 0 | SUCCESS | Passed | 15.487 s |

The first check attempted a document read in the empty directory and a directory listing; the read failure remained nonfatal. It verifies provider completion and validation, not strict Watcher tool confinement. The second check called no extra tools and returned `issueSummary: ""` and `attemptedApproaches: []` with no diagnostics. Neither process remained live at completion.

The full runtime suite passed 584/584 with exit code 0, including all six new regressions. `npm run runtime:bundle` completed successfully. The [verification evidence](evidence/2026-10-21-antigravity-finish-fix.json) records the real CLI checks, replay, test totals and built runtime digests.

## Delivery boundary

These are source changes and standalone provider evidence. The already-open stable Deszo executable and its adjacent runtime have not been replaced or restarted. The canceled Fixer run remains canceled, and no live incident is closed by this document.
