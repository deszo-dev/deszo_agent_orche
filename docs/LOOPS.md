# Conditional Loops

Version: 0.8  
Status: proposed M2 semantics; nesting/review workflow at M4  
Updated: 2026-10-13

Loops are included in the first user release. M1 is a technical prerequisite; M2 ships single-level loops with Agent or deterministic checking. This document owns carry, decisions, limits, recovery, and scoped execution.

## Container and carried value

A Loop has one required `seed` input and one final `result` output of the configured type: Text, JsonValue, or ArtifactSet. One JsonValue can carry a structured record with several fields. JsonValue loops require a pinned standalone state schema, validated for seed and every candidate.

Loop Input exposes `value`, `iteration` (1-based JsonValue integer), and `feedback` (Text from the previous decision, initially empty). Loop Return accepts exactly one `candidate` of the seed type and one `decision: JsonValue`. Boundaries belong to the container, not the palette.

The same captured body DAG runs once before checking. There is no pre-check skip; put an explicit Route before a Loop when a valid approved value can bypass it. Body edges cannot cross scope boundaries except declared input/return bindings. Unrestricted feedback edges are rejected.

Use [pipeline-state.schema.json](schemas/pipeline-state.schema.json) `specificationState` and `deliveryState` for the reference pipeline. Issues with engine-assigned IDs live in the **carried record**. Decision feedback remains Text for the next prompt/UI. No issue IDs are recovered by parsing feedback prose.

## Decision and record construction

Decision schema: [loop-decision.schema.json](schemas/loop-decision.schema.json). It permits only Boolean `continue`, string `reason`, and string `feedback`.

```json
{"continue":true,"reason":"Documentation requires revision.","feedback":"Address the identified blockers in the carried issue list."}
```

`continue = false` publishes the current candidate and finishes normally. `true` starts the next iteration using that candidate and feedback. A malformed/missing decision never means finish.

M2 adds these explicit utilities; their serialized node variants are required before M2 coding:

| Utility | Inputs/configuration | Output and error behavior |
| --- | --- | --- |
| Merge — record mode | Named typed inputs; fixed named fields, each from an input/root or JSON Pointer, or a literal. No expressions/scripts. Optional pinned output schema. | `value: JsonValue` object. Every field is present; missing pointer/type/schema is a contract failure. Text stays string, JSON stays JSON, ArtifactSet is explicitly encoded as its verified typed manifest reference. |
| JSON Select | `value: JsonValue`; RFC 6901 pointer; `outputType`; explicit Text `raw-string` or `canonical-json` rendering; optional declared null/default handling. | `value` of declared Text/JsonValue/ArtifactSet type. Text raw mode requires a string. ArtifactSet conversion requires an existing hash-verified manifest/subject reference. Null-to-empty ArtifactSet is allowed only when configured. |
| Condition | `value: JsonValue`; `doneWhen` pointer + equals/not-equals literal or Boolean test; reason/feedback from literal strings or raw-string pointers. | `decision: JsonValue` with continue = !doneWhen. Missing/type-invalid pointers fail; do not coerce strings such as "false". |

All-required ArtifactSet Merge retains declared input namespaces in its manifest and rejects incompatible path collisions; it does not apply code patches or silently overwrite files.

Record Merge is an extension of Merge, so the palette still has sixteen target types. All-required Merge waits for every input; M4 selected-alternative mode is defined in [Pipeline execution](PIPELINE_EXECUTION.md#route-and-selected-join).

## Gate to Loop Return

Gate evaluates all required role decisions before emitting `report`. OPEN and REVISION_REQUIRED are terminal reports for that evaluation; PENDING is a live inspection state with no data output.

For Specification Loop:

- Gate report `/status` → Condition `doneWhen.equals = "OPEN"`.
- Condition reason and feedback take report `/reason` as Text.
- A record Merge copies businessTask/base, takes the captured specification reference, takes report `/issues` with stable IDs, and takes its certificate (or null).
- Merge value → Return.candidate; Condition.decision → Return.decision.

The record, not Text feedback, reaches Analyst as structured issue data in the next iteration. The [wired body](TEST_PIPELINE.md#specification-loop-wiring) declares every boundary/selector/return and role input.

An Agent checker instead emits the decision schema directly. Candidate capture must complete before checker dispatch. Freeze/checker replay is prohibited where it would reuse a judgment for another candidate.

## Limits and active clock

Limits pause for user action; they do not produce normal success. Count and time are independent guards, so reaching either first pauses the scope.

| Proposed setting | Iterations | Active-time backstop |
| --- | --- | --- |
| Generic simple Loop | 5 | 30 minutes |
| Reference Specification Loop | 5 | 120 minutes |
| Reference Delivery Loop | 5 | 360 minutes |
| Reference task-repair scope | 3 | 90 minutes |

These are conservative initial configuration values, not measured performance or a guarantee that every iteration can finish before the clock cap. Instrument first and tune from actual runs. At the end of the last permitted body, false still finishes; true pauses without starting an excess iteration.

Active time is wall-clock duration of the **union** of intervals during which the scope's engine work or any owned descendant attempt/process is running. Concurrent children do not add their durations together. Exclude provider-capacity waits, directory/Context-lock waits, and user-paused time. Queue time remains separately visible in telemetry. Measure elapsed intervals with a monotonic clock and journal durations alongside UTC timestamps; do not derive active time by subtracting editable calendar times.

Parent scopes include active descendant work; each child's own clock includes only its descendants. Parent and child caps are enforced independently. Agent timeout counts launched process time and can fire before the enclosing Loop cap. No unbounded retry on timeout/quota.

## Failure and recovery

| Trigger | Result |
| --- | --- |
| Valid continue decision | New numbered iteration with committed candidate |
| Valid finish decision | Successful Loop result |
| Valid review rejection or captured failed check | Workflow data drives bounded rework |
| CLI crash, timeout, invalid JSON, missing artifact or corruption | Scope blocked/paused; no candidate substitution |
| Count/time cap | Paused with the current candidate/evidence and reason |
| Stop Loop/parent | Cancel owned descendant trees; close only after exit |
| Runtime restart | Interrupted scope; explicit recovery, never automatic calls |

M2 makes `waiting_for_user` reachable: its entry/exit transitions, precedence with failure, Stop and restart, and the recovery commands are defined in [M2 contracts](M2_CONTRACTS.md#m2-run-lifecycle). A binding's needs_review alone never changes a run outcome; it constrains `retry`.

M2 manual Retry reuses captured inputs only when Context/filesystem prerequisites are verified. Native turns or mutable files may have advanced during a failed attempt. User choices are acknowledge current binding and retry, create fresh binding/materialization, restart scope, or cancel. A retry is another attempt in the same iteration; valid workflow rework is another iteration. Preserve both.

Raising a limit while paused is an explicit journaled command on that captured scope. It does not edit old events or mark the interrupted attempt successful.

## Nested ownership

M4 allows Loop within Loop and M5 task-repair scopes inside Map. Every scope has one parent and owns descendants' resource leases. A child receives delegated directory reservations without deadlocking on its parent's lease; unrelated scopes cannot use the directory. Acquire all external resources atomically using [the generic scheduler](M1_CONTRACTS.md#scheduler-and-resource-locks).

Stop/pause propagates downward; completion waits for descendants and owned processes. Generated graph state is captured for history; presentation is not scope ownership.

## Cache inside a loop

Cache at M3 is a standalone checkpoint:

- Live consumes upstream and commits a fresh pin after success.
- Frozen emits its pinned value and cuts that upstream **data** dependency for the selected branch; other consumers and live After prerequisites remain.
- Refresh executes the required producer path once and replaces a pin only after successful capture. Failure keeps the prior pin inspectable, but is not a successful refresh.

Inside Loop, Frozen intentionally supplies the same pinned value on every iteration. Refresh during a paused iteration is journaled and applies to later planned attempts; it never mutates a captured prior input.

Reject a Frozen Cache between current candidate/checker/Return decision: the condition must evaluate this iteration's candidate. A pinned old decision cannot close a new iteration. A Frozen coding report cannot restore its native turns/filesystem effects; [stateful prerequisites](M1_CONTRACTS.md#later-reruns-and-context-chat) still apply.

## Inspection and later serialization

M2 Replay shows seed, candidate, decision, structured issues, feedback, count/time guards, attempts, and pause reasons per iteration. M4/M5 add nested and generated identities; M6 opens those historical canvases.

The decision and pipeline-state schemas supplied here are concrete. The M2 node/boundary/config serialization and the scoped API/event catalogue are in [M2 contracts](M2_CONTRACTS.md); they are accepted only with the `loops-v1` capability.
