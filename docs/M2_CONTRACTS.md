# M2 Execution Contracts

Version: 0.10
Status: concrete M2 contract package; implemented with M2
Updated: 2026-10-13

This is the normative home for the M2 node variants (`loops-v1`), loop scope execution, the M2 run lifecycle with `waiting_for_user`, recovery commands, API v2, journal v2 and migration 2. [Loops](LOOPS.md) keeps carry/decision/limit semantics; [M1 contracts](M1_CONTRACTS.md) keep everything this document does not change.

## Versioning

| Asset | M1 | M2 |
| --- | --- | --- |
| Workflow | `capabilities: ["core-v1"]` | `["core-v1", "loops-v1"]` enables the variants below; `["core-v1"]` stays valid and means exactly the M1 catalogue |
| Values | Text, JsonValue | adds ArtifactSet ([value schema](schemas/value.schema.json)) |
| Journal | envelope `schemaVersion: 1` ([v1](schemas/journal-event.schema.json)) | every run created by the M2 runtime writes `schemaVersion: 2` ([v2](schemas/journal-event-v2.schema.json)); stored v1 journals stay readable |
| API | `/api/v1` ([v1](schemas/runtime-api.schema.json)) | `/api/v2` ([v2](schemas/runtime-api-v2.schema.json)); the M2 runtime serves only v2 |
| Database | migration 1 ([m1.sql](storage/m1.sql)) | migration 2 ([m2.sql](storage/m2.sql)) |

The M1 schemas and fixtures remain the historical core-v1 contract. In particular, `waiting_for_user` is still rejected by the v1 API/journal schemas. It is valid only in v2.

## Node catalogue additions (`loops-v1`)

| Type | Config | Inputs | Outputs |
| --- | --- | --- | --- |
| `file-input` | `mode: files` with `paths` (normalized relative paths, read from the workspace directory when the node runs), or `mode: artifact` with `valueType` and a pinned `artifact` reference | None | `value`: ArtifactSet (files) or the declared `valueType` (artifact) |
| `merge` | `mode: text` (ordered `inputs`, literal `separator`); `mode: artifacts` (ordered `inputs`); `mode: record` (typed `inputs`, ordered `fields`, optional `schema`) | One required input per declared input ID | `value`: Text, ArtifactSet or JsonValue respectively |
| `json-select` | `pointer` (RFC 6901), `outputType`, `render` (`raw-string` or `canonical-json`, required for Text only), `nullAs` (`error` or `empty`, ArtifactSet only) | `value: JsonValue` | `value` of `outputType` |
| `condition` | `doneWhen` (`pointer`, `op` = `equals` / `not-equals` / `is-true` / `is-false`, `value` for the first two), `reason` and `feedback` (each a `literal` string or a `pointer` to a string) | `value: JsonValue` | `decision: JsonValue` |
| `loop` | `valueType`, `stateSchema` (required for JsonValue), `fixedInputs`, `limits` (`maxIterations` 1–50, default 5; `maxActiveMinutes` 1–1440, default 30), `body` | `seed` of `valueType`; one input per fixed input ID | `result` of `valueType`; `decision: JsonValue` |

Agent gains two optional `loops-v1` fields: `attachFiles: true` adds a required `files: ArtifactSet` input; `captures` (normalized relative paths) adds a `files: ArtifactSet` output. Context gains `lifetime: run | iteration` (only for `mode: new`; `iteration` only inside a loop body). Result Viewer accepts Text, JsonValue or ArtifactSet.

Without `loops-v1`, these types and fields are rejected (structurally for node types, semantically with `capability.loops` for the new Agent/Context fields).

### Utility semantics

- **Text merge** concatenates inputs in declared order with the literal separator; bytes are preserved.
- **Artifact merge** unions entries in declared order. The same path with the same digest is deduplicated; the same path with a different digest is a contract failure (no last-writer-wins). The manifest records each source manifest.
- **Record merge** builds an object with exactly the declared fields. A field source is `{ "input": id }` (whole value), `{ "input": id, "pointer": "/x" }` (JsonValue inputs only) or `{ "literal": <json> }`. Text becomes a string; ArtifactSet becomes `{"kind":"ArtifactSet","manifest":{"artifactId":…,"sha256":…}}`. A missing pointer target fails; an optional `schema` validates the result. Zero inputs with literal fields is a valid way to build a JsonValue seed.
- **JSON Select** fails on a missing target. Text `raw-string` requires a string; `canonical-json` renders RFC 8785 JSON. ArtifactSet requires the record-merge encoding of an existing verified manifest, or `null` with `nullAs: empty`.
- **Condition** evaluates `doneWhen` without coercion (`"false"` is not `false`; `is-true` requires a Boolean). It emits the [loop decision](schemas/loop-decision.schema.json) with `continue = !doneWhen`.
- **File input (files)** reads each path inside the workspace directory: no absolute paths, `..`, empty segments, backslashes or globs; symlink/junction escapes are rejected after resolution. Each file is at most 16 MiB and the set at most 64 MiB. A missing file fails with `input_unavailable`.
- **File input (artifact)** pins an existing artifact. Its digest is verified when the run is created and again when the node runs. Text requires a text media type, JsonValue requires `application/json`, ArtifactSet requires a manifest.
- **Agent attachments** are materialized as read-only copies under `<root>/workdirs/attachments/<attempt-id>/`. The resolved prompt gains a visible attachment section that lists each path; it is recorded as a prompt source of kind `attachments`.
- **Agent captures** are read from the workspace directory after a successful exit, with the same path and size rules. A missing file is an `output_contract` failure.

## Loop body

`body` contains `nodes`, `edges`, `after` and an optional `view`. Body nodes may be any non-loop type; nested loops are M4. Node IDs are unique across the whole workflow, including all bodies.

Body edges may use two reserved endpoints. They are part of the container, not nodes:

| Endpoint | Ports |
| --- | --- |
| `$input` (source) | `value` (valueType), `iteration` (JsonValue integer, 1-based), `feedback` (Text; empty in iteration 1), one port per fixed input ID |
| `$return` (target) | `candidate` (valueType), `decision` (JsonValue) — each exactly one edge |

Semantic rules (codes in brackets): every body executable leads to `$return` [`node.sink`]; the body is a DAG [`graph.cycle`]; unknown boundary ports [`loop.boundary`]; missing or duplicate return edges [`loop.return`]; outer edges cannot target body nodes or vice versa [`edge.endpoint`]. Body Agents may reference an outer Context (shared across iterations) or a body Context. Outer Agents cannot reference body Contexts [`context.reference`]. For ordering, an outer Agent that shares a Context with any body Agent must be ordered against the loop node [`context.unordered`]. A body Context with `lifetime: iteration` starts a fresh native session in each iteration; `lifetime: iteration` outside a body is rejected [`context.lifetime`].

## Loop execution

1. When all outer predecessors succeed, the loop attempt commits its inputs (seed and fixed inputs) and becomes `running`. The engine validates a JsonValue seed against `stateSchema`, then journals `loop.started`.
2. **Iteration n** plans one node instance per body executable, with ID `<loop-id>/<n>/<node-id>`; each gets an ordinal-1 attempt in `scheduled`. Then `loop.iteration_started` records the value and feedback references.
3. When both return sources have succeeded, the engine validates the candidate (type, plus `stateSchema` for JsonValue) and the decision (loop-decision schema). It journals `loop.iteration_returned`.
4. `continue = false`: `loop.finished`, the loop outputs commit (`result`, `decision`), and the loop attempt succeeds.
5. `continue = true`: if `n = maxIterations`, journal `loop.paused` (`iteration_limit`) and move the loop attempt `running → waiting`. Otherwise iteration n + 1 starts with value = candidate and feedback = decision feedback.

The active clock is the union of intervals during which any body attempt of the loop is running, measured monotonically. When it exceeds `maxActiveMinutes`, the engine stops the running body processes (their attempts become `canceled`) and journals `loop.paused` with `time_limit`. A body attempt failure or an invalid candidate/decision journals `loop.paused` with `body_failure` and latches the run failure. A scoped Stop on the loop journals `loop.paused` with `stopped`. A paused loop's consumers stay held. Loop attempt states add `running → waiting` (paused) and `waiting → running` (resumed).

## M2 run lifecycle

| Current | Trigger | Next |
| --- | --- | --- |
| `queued` | Scheduler starts | `running` |
| `running` | Every outer executable's latest attempt succeeded | `succeeded` |
| `running` | Operational failure of any attempt, or invalid loop return | `draining`: no new dispatch; unstarted attempts stay `scheduled` (held) |
| `running` | Nothing is running or dispatchable, and something is held (failed, canceled or paused work) | `waiting_for_user` |
| `draining` | All running attempts have finished and committed | `waiting_for_user` |
| `waiting_for_user` | Valid `retry`, `raise-limit` or `restart-iteration` | `running` |
| `waiting_for_user` | `close` | `failed`; unstarted attempts become `canceled`, paused loops `canceled` |
| `queued/running/draining/waiting_for_user` | Root Stop | `stopping` → `canceled` after all child processes exit |
| Any nonterminal | Runtime restart / loss of supervision | `interrupted` (terminal; restart never reopens a run) |

Precedence: Root Stop wins over recovery; restart wins over everything. A failure while a loop is paused still drains. `needs_review` on a binding never changes the run state by itself; it constrains `retry` (below). A `waiting_for_user` run keeps its workspace's single active-run slot until it is closed or stopped.

This lifecycle applies to every run created by the M2 runtime, including core-v1 workflows. The M1 fixture expectation `draining → failed` remains the historical core-v1 contract.

## Recovery and scoped Stop

`POST /api/v2/runs/{runId}/recovery` with `recoveryRequest` (idempotent `requestId`). Every action except `close` requires `waiting_for_user`.

| Action | Target | Effect |
| --- | --- | --- |
| `retry` | `nodeInstanceId` whose latest attempt is `failed` or `canceled` | New attempt (ordinal + 1, `scheduled`) with the same captured upstream values. `binding`: `keep` requires a `ready`/`unbound` binding; `acknowledge` accepts a `needs_review` binding (→ `ready`, or `unbound` when no native session ID was ever reported); `fresh` maps the Context node to a new unbound binding (`mode: new` only; the old binding stays historical). Retrying a body node of a loop paused by `body_failure` resumes the loop. |
| `raise-limit` | `loopNodeId`, new `maxIterations` / `maxActiveMinutes` (each ≥ current) | `loop.limits_changed`; an `iteration_limit` pause starts the next iteration; a `time_limit` pause re-plans the canceled body attempts as new attempts |
| `restart-iteration` | `loopNodeId` of a paused loop | New attempts for every body instance of the current iteration; the same iteration number is kept |
| `close` | none | `waiting_for_user` → `failed` |

Each accepted action journals `run.recovery_requested` before its effects. Rejections return 409 (wrong state or target) or 422 `context_unavailable` (binding constraint).

`POST /api/v2/runs/{runId}/nodes/{nodeInstanceId}/stop` (URL-encoded scoped ID) cancels that attempt's process tree; its consumers stay held; unrelated work continues. On a loop node it stops the running body work and pauses the loop with `stopped`. Idempotent per `requestId`; 409 when the target is not running.

## API v2 changes

All M1 endpoints move to `/api/v2` with unchanged payloads except:

- `run.state` and run filters accept `waiting_for_user`.
- `runSnapshot.instances` lists every node instance, including scoped body instances, with its latest attempt. `runSnapshot.loops` lists each loop execution (`state`, `iteration`, limits, `activeMs`, `pauseReason`).
- New `recoveryRequest`, `nodeStopRequest` and `commandResponse` definitions; `capabilities.engineCapabilities` lists `core-v1` and `loops-v1`.

## Journal v2

[journal-event-v2.schema.json](schemas/journal-event-v2.schema.json) keeps every v1 event type. It adds `waiting_for_user`, scoped node instance IDs, the error code `input_unavailable`, and these events: `loop.started`, `loop.iteration_started`, `loop.iteration_returned`, `loop.paused`, `loop.resumed`, `loop.limits_changed`, `loop.finished`, `run.recovery_requested`. Loop events carry the loop node as `nodeInstanceId` and the loop attempt as `attemptId`.

## Migration 2

[m2.sql](storage/m2.sql) rebuilds `runs` so that its state CHECK and the one-active-run index include `waiting_for_user`, and adds `journal_version` (1 or 2). It rebuilds `node_instances` with identity `(run_id, id)` only, because scoped body instances repeat a node ID in every iteration. It also adds `loop_executions` and `loop_iterations`. The runtime backs up `state.sqlite` before applying a migration and never reinterprets stored v1 events.

## Replay (read-only)

Replay projects a run from its captured workflow and ordered journal. It is implemented in [shared/replay.mjs](../shared/replay.mjs) and used by the UI:

- Steps are journal sequences; by default `attempt.log_chunk` events are skipped by Next/Prev, but they remain in the journal.
- The state at step k folds events 1..k: run state, every node instance's latest attempt state, loop iteration/pause, binding states, and the input/output manifests committed by then. Later outputs are invisible.
- Opening a loop in Replay shows its body for a selected iteration, using the scoped instance IDs.
- Replay issues no command and no provider call, and restores no files or native sessions.
