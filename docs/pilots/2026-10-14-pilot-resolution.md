# Pilot validation — resolution

Date: 2026-10-14  
Pilot: [pilot validation](2026-10-14-pilot-validation.md)  
Outcome at the original code-fix stage: PILOT-01, PILOT-02 and PILOT-03 were corrected in production code, with regression tests. The [pilot rerun](2026-10-14-pilot-rerun.md) then passed installed startup/crash recovery, Replay and the 30-minute soak, and exposed RERUN-04. After its correction, the [live follow-up](2026-10-14-after-rerun04-validation.md) reached final Customer acceptance: 28 exported tests and 21 independent business checks passed, with one documented operator restart of the Specification Loop.

## Verification at the original code-fix stage

| Check | Result |
| --- | --- |
| `npm test` | 339 passed, 0 failed (previously 330). New: `runtime/tests/pilot.test.mjs` and three `output.transport` contract fixtures |
| `npm run docs:check` | Pass; 42 negative semantic cases (three new `output.transport` cases mirrored by the Python oracle) |
| `cargo test --locked` (`src-tauri`) | 4 passed: path normalization, runner startup from a canonical `\\?\` path, supervisor drain after a contained runtime dies, and the Job descendant test |
| `npm run build`, `npm run runtime:bundle`, `cargo check --locked` | Pass |

The fixture CLI rejects native schemas outside the documented subset, mirroring the Codex error text. Every existing test that sends a schema, including the M4 specification loop, the Map tests and the reference Delivery Loop, checks this subset. The [rerun](2026-10-14-pilot-rerun.md) exposed further AGY function-schema/finish-tool behavior that fixtures alone did not prove compatible.

## PILOT-01 — native structured-output schemas: fixed

The engine no longer sends the answer contract as the native schema. It derives a deterministic, documented **transport schema**:

- root composition, conditionals and `allOf` are folded or dropped;
- a union of objects is merged into one object;
- every object is closed with every property required, and optional properties are sent as nullable and decoded back before validation;
- only strict-subset keywords are kept.

The complete contract is still sent in the prompt, and every decoded answer is validated against it. The dropped rules therefore still hold; for example, "CHANGES_REQUESTED needs a blocker" is still enforced by the engine. A contract that cannot be transported (free-form object, open map, non-object root) is refused before any request. At save time it is the semantic issue `output.transport`; at dispatch it is an `output_contract` failure. Nothing retries in a weaker mode or extracts JSON from prose.

- Code: [transport.mjs](../../runtime/core/transport.mjs); its use in `executeAgent` ([engine.mjs](../../runtime/core/engine.mjs)), in `outputContractText` ([adapters.mjs](../../runtime/core/adapters.mjs)) and in workflow validation ([validate.mjs](../../runtime/core/validate.mjs)).
- Contract: [native structured-output transport](../M1_CONTRACTS.md#native-structured-output-transport).
- Examples: the M4 specification-loop reviewers now declare the complete ReviewDecision. Their former free-form `issues` items could not cross a strict native schema.
- Tests in `pilot.test.mjs`:
  - ReviewDecision, TaskReturn, TaskReview, TriageDecision and LoopDecision all have compliant transports, while the raw contracts are rejected.
  - Decoding, and full-contract enforcement after decoding.
  - Refusal of untransportable contracts.
  - New and resumed invocations of all three providers carry only the transport.
  - The fixture CLI rejects a raw contract the way the real CLI does.

## PILOT-02 — installed desktop cannot launch Node: fixed

The launcher now normalizes every path it hands to Node (runner script, storage root, connection file):

- the Windows verbatim prefix is removed;
- a verbatim UNC path becomes `\\server\share`;
- paths with spaces are passed unchanged as single arguments.

A missing bundled runner is reported before spawning.

The new native test `runner_starts_from_a_canonical_resource_path` canonicalizes the bundled `dist-runtime/runner.mjs` and confirms the path carries the `\\?\` prefix, exactly as the installed app's resource directory provides it. It then launches Node through the normalized path with a storage root containing spaces, and waits for the runner's authenticated connection (port and token).

`supervisor_drains_the_job_when_the_runtime_dies` exercises the supervisor core without a window: a contained "runtime" starts a long-running descendant and dies; the supervisor notices on its own, drains the Job to zero processes and reports the loss.

- Code: `node_path`, `watch_generation` and the tests in [main.rs](../../src-tauri/src/main.rs).
- Contract: [process containment](../M1_CONTRACTS.md#process-containment).
- Subsequently repeated: isolated NSIS installation, installed startup, runtime/app crashes with live CLI descendants, and automatic frontend reconnection; see the [rerun evidence](2026-10-14-pilot-rerun.md).

## PILOT-03 — closed loops shown as paused or in progress: fixed

The Replay projector now tracks which attempt owns each Loop and Map. When that attempt is canceled, interrupted or failed (by root Stop, `close` or restart recovery), it applies the transition: the loop shows `canceled`/`interrupted` with no pause reason, and the Map projection ends as well. An iteration that returned no LoopDecision keeps `continue: null`, records its `outcome`, and is labeled "closed without a decision"; no finish decision is invented. Nested loops end through their own attempts the same way.

- Code: [replay.mjs](../../shared/replay.mjs), [Replay.tsx](../../src/Replay.tsx).
- Contract: [Loop and Map lifecycle in Replay](../RUN_HISTORY_AND_REPLAY.md#loop-and-map-lifecycle-in-replay).
- Test: the pilot's sequence on fixtures. A loop pauses on a body failure, and the projection shows `paused` before closure. After `close` the run is `failed`, the loop `canceled` with no pause reason, and the last iteration undecided with outcome `canceled`.

## Subsequent validation

The user authorized the rerun, including real subscription calls, isolated packaging and a 30-minute fixture soak. The [rerun report](2026-10-14-pilot-rerun.md) preserves those results and the historical blocker RERUN-04. That defect is [corrected](2026-10-14-pilot-rerun-resolution.md). The [subsequent live validation](2026-10-14-after-rerun04-validation.md) completed final Customer acceptance and the independent [acceptance probe](../../scripts/pilot-acceptance.mjs) over the accepted export. It also records further recovery/triage/tooling fixes and the practical limits of the successful small-project pilot. No repeated authorization was requested for the already authorized pilot scope.
