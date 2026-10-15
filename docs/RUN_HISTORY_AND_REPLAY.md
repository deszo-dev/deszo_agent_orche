# Run History and Replay

Version: 0.8  
Status: M1 journal contract; M2/M6 Replay design  
Updated: 2026-10-13

Every workflow run has a complete inspectable journal. This document owns event types and Replay projection behavior. [Storage](STORAGE.md#database-and-commit-boundary) owns durability; [M1 contracts](M1_CONTRACTS.md#httpsse-api) owns transport and state transitions.

## M1 journal envelope and catalogue

Use [journal-event.schema.json](schemas/journal-event.schema.json). Required envelope fields are schemaVersion, UUID event/run IDs, sequence, UTC timestamp, nullable nodeInstanceId/attemptId, type, and typed payload. M1 node instance IDs equal captured node IDs; future generated scopes extend their identity grammar and envelope schema explicitly.

| Event type | Payload meaning | Required scope |
| --- | --- | --- |
| `run.created` | Exact workflow/settings snapshots and execution hash | Run |
| `run.state_changed` | Previous nullable state, next state, reason, including draining | Run |
| `run.capacity_changed` | Application capacity revision and immutable settings reference | Run |
| `node.planned` | Captured executable node ID/type | Node; no attempt |
| `attempt.state_changed` | Previous nullable state, next state, reason, nullable process identity | Node + attempt |
| `attempt.inputs_committed` | Input manifest, optional resolved prompt and Context binding | Node + attempt |
| `attempt.invocation_committed` | Exact invocation manifest | Node + attempt; Agent only |
| `attempt.log_chunk` | Immutable stdout/stderr/normalized chunk reference and zero-based stream index | Node + attempt |
| `attempt.outputs_committed` | Atomic output manifest | Node + attempt |
| `attempt.error` | Typed operational error, message and optional evidence | Node + attempt |
| `context.state_changed` | Binding ID, state transition, reason | Run-associated binding |
| `context.bound` | Provider, native-session reference and cwd identity | Run-associated binding |

The schema rejects unknown M1 event types and fields. It validates states and references; transition legality, reference existence, scope ownership, and success-before-output ordering are semantic validation.

AcknowledgeContext outside a run is captured as an immutable binding update and idempotent command receipt. It does not append fictional execution events to a completed run. A later run's input manifest pins that binding update.

## Required event order

For a run: run.created → queued transition → node.planned events → running → attempts → terminal transition. Plan all executable nodes and their ordinal-1 attempts before dispatch; each node.planned is followed by its null → scheduled attempt transition. Persist run Context mappings at plan time. Context declarations have no node attempt.

For a successful Agent: scheduled/waiting → inputs committed → invocation committed → running → log chunks → outputs committed → succeeded. Static utilities omit invocation/logs but still record inputs, outputs, and states. Input/invocation records are persisted before launching an external process; the running event follows successful launch and captures PID/start/supervisor identity for an Agent. Static/terminal transitions use null process identity; the last known launched identity remains in the attempt record. An immediate spawn failure records error + failed without claiming process execution.

On failure: capture the failed attempt's error/evidence and termination, commit its failed state, latch draining and block unstarted attempts atomically. Already running siblings finish normally and commit their outputs/Context updates. Commit failed for the run only after all running attempts finish capture. Root Stop can cancel them explicitly. [Run/attempt transitions](M1_CONTRACTS.md#run-and-attempt-transitions) own the exact policy; Stop and restart are journaled even without outputs. Binding needs_review events remain separate from failed/canceled/interrupted run outcomes. M1 never emits a waiting_for_user run transition; M2 must extend its versioned state/event catalogue before using that reserved state.

Per-run sequences start at 1 and have no gaps. Concurrent events use engine commit order. Every log chunk is immutable; a stream-complete marker is supplied by the terminal attempt. Interrupted attempts can have partial streams and no successful outputs.

## Log batching

Batch each attempt stream (stdout, stderr, normalized) in arrival order. Flush at 64 KiB of buffered bytes or 250 ms since the first buffered byte, whichever comes first; flush a partial batch before any terminal event. Split oversized reads at the size threshold, retain raw bytes without decoding away partial UTF-8 characters, and use a separately recorded normalized stream for parsed provider events. chunkIndex is contiguous from 0 per stream. A chunk is a captured byte batch, not one CLI line. Raw batches use application/octet-stream; viewers decode the ordered stream incrementally rather than treating each batch as standalone UTF-8 or JSON.

Bound pending capture to 1 MiB per attempt across streams. Apply pipe/backpressure when storage cannot keep up; never drop/truncate old bytes. Disk/commit failure becomes a capture/corruption error and stops further dispatch; it cannot produce success. Previously uncommitted buffers may be lost on a crash, so interrupted streams are explicitly partial. Completed attempts require all their bytes flushed before the terminal commit.

Publish durable batch references with inline journal envelopes using [the storage transaction](STORAGE.md#database-and-commit-boundary). Reuse immutable stored chunk boundaries in Replay: Next/Prev never re-batches according to the playback clock. Timer boundaries can differ between separate live executions; determinism means the **same captured run** always has the same steps. State/input/output/Stop commits flush promptly and are not delayed to fill a log batch.

## Capture completeness

Store the workflow/view, settings, resolved inputs/prompt sources, explicit provider/model/configuration, CLI identity/arguments/cwd, native binding references, raw/normalized logs, outputs, errors, and terminal state. Secret values are excluded from invocation/environment manifests. The output manifest references the exact Text/JSON artifacts, not a mutable “latest result”.

History can display failed/canceled/interrupted runs without inventing absent outputs. Raw CLI events are evidence rather than trusted scheduler instructions.

## M2 Replay

Replay opens the captured workflow/view and reads validated events. Next/Prev moves through meaningful committed events, showing node states, inputs/outputs, attempts, decisions, and loop iteration. The editor draft stays separate.

Replay is read-only: no CLI/tool call, filesystem restoration, native-session rewind, cache refresh, or historical deployment. Unavailable/corrupt evidence is shown explicitly; do not re-run a provider to fill a gap.

For a parallel run, a sequence step shows the actual committed state of every node, including unfinished neighbors. A filter can hide noisy log chunks while retaining their place in the complete journal.

M2 adds explicit scope/iteration fields and event families for Loop created/iteration start/return/limit/pause/recovery, scoped Stop/Retry, and Replay checkpoints. These are not accepted by the current M1 schema until its milestone extension is written.

## Loop and Map lifecycle in Replay

A Loop or Map ends through its own attempt as well as through its lifecycle events: Root Stop and `close` cancel it, restart recovery interrupts it. Replay folds those attempt transitions into the Loop and Map projections, so a closed run shows the loop as `canceled` or `interrupted`, never still `paused`. An iteration that returned no LoopDecision keeps `continue: null` and records how it ended (`outcome`), and is labeled "closed without a decision" rather than "in progress"; no finish decision is invented.

## M4–M6 generated history

| Milestone | Additional durable facts |
| --- | --- |
| M3 | Cache pin/refresh/stale events, manual Context turns, execution-selection prerequisites |
| M4 | Specification captured, role view manifests, issues/review decisions, Gate reports/certificates, Route selection/inactive branches, nested scope ownership |
| M5 | Map/template generation, task readiness/attempt/result selection/acceptance/invalidation, materialization, assembly/conflicts, actual checks/triage, map verification-cycle count and limit/pause events |
| M6 | Verified carry certificates, reviewer-needed projection, revision transitions, generated-canvas Replay checkpoints |

Before each milestone, add the exact event payloads to a versioned catalogue/schema and database migration. Do not infer these facts later by parsing Agent prose.

M5 captures expanded DAG/template/view snapshots even before the M6 historical generated-canvas viewer is delivered. M6 Replay can open the exact map/task/loop generation that existed at an event and show result A under review while result B is in progress.

Checkpoints are optional projection accelerators tied to a validated journal sequence/hash. They never replace the event source or create missing execution facts. The map navigator and Replay derive progress from the same stored selections and criteria.
