# M1 Execution Contracts

Version: 0.8  
Status: concrete proposed core-v1 contract; no new runtime behavior implemented  
Updated: 2026-10-13

This is the normative home for the generic node catalogue, DAG validation, scheduling, Context bindings, recovery, and M1 runtime commands. Later scoped execution is specified in [Loops](LOOPS.md) and [Pipeline execution](PIPELINE_EXECUTION.md).

## Workflow and identity

Use [workflow.schema.json](schemas/workflow.schema.json). M1 accepts `schemaVersion: 1` and exactly `capabilities: ["core-v1"]`. Unknown capabilities, node variants, config fields, or schema versions are rejected; later milestones explicitly extend this catalogue. Presentation is optional `view` keyed by existing node IDs. Positions and labels affect neither prompts nor execution identity.

Use exactly two workflow hashes. `snapshotSha256` hashes the exact saved artifact bytes, including `view`; the engine saves UTF-8 [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785) JSON, rather than the original HTTP whitespace. `executionHash` hashes JCS JSON excluding `view`. Reject duplicate keys, non-finite numbers, and non-I-JSON values before saving/hashing. `savedWorkflow` returns both hashes. `createRun.workflowSnapshotSha256` pins **snapshotSha256**, and must equal the captured `workflowSnapshot.sha256`. There is no third structural digest. A captured run never reads changing editor state.

A workspace binds one canonical existing project or managed scratch directory outside the trusted store. `workspaceId` resolves that local binding when a run is created. Portable workflow JSON contains no absolute cwd, credentials, or native session ID. Continue mode references a local opaque binding ID; portable export removes it and requires explicit rebinding before execution.

## Core node and port catalogue

Data edges have one source and one target. A required input receives exactly one edge. Fan-out is unrestricted; a Context link is a reference, not a data edge.

| Type | Config | Inputs | Outputs |
| --- | --- | --- | --- |
| `text` | `value`: literal string | None | `text: Text` |
| `prompt-template` | `template`: string; `slots`: declared slot IDs/descriptions | One required `Text` input named by each slot ID | `text: Text` |
| `agent` | `provider`, explicit nonempty `model`, `effort`, optional `contextId`, `timeoutSeconds`, `output` | `prompt: Text` | `text: Text`; also `json: JsonValue` when `output.format = json` |
| `context` | `provider`; `mode = new` or `continue`; `bindingId` required only for continue | None | None; Agent configuration refers to this node |
| `result-viewer` | Empty config | `value: Text or JsonValue` | None |

Text can be empty. Prompt Template uses exact `{{slot-id}}` markers, with IDs matching the workflow ID grammar. Slot IDs must be unique, even when their description fields differ. Declared slots and marker IDs must be the same set; a marker may occur several times. Malformed double-brace markers, undeclared markers, or disconnected slots are validation errors. Ordinary single braces in JSON remain literal. Substitution preserves incoming bytes and performs no code evaluation, JSON parsing, or automatic coercion.

Agent output `text` is the adapter's successful final answer, not the CLI's entire stdout. In JSON mode, parse that answer once, reject duplicate keys, validate the embedded optional `output.schema` as a standalone Draft 2020-12 JSON Schema, and expose a canonical JSON artifact at `json`. External schema references/network fetching are disallowed; local `#/$defs/...` references are allowed. The Text answer and parsed JSON commit atomically. Invalid JSON/schema, unsuccessful terminal status, or unsuccessful process exit produces no successful output.

[M1 value references](schemas/value.schema.json) describe how committed values are referenced. [Attempt manifests](schemas/attempt-record.schema.json) map port IDs to these references, pin the exact pre-invocation binding artifact as well as its local ID, and capture requested/observed model and native-session facts after success. They pin the resolved prompt, configuration, and invocation. The engine appends the selected output contract as a visible prompt source, rather than relying on an agent to invent the format. Provider stdout, normalized events, and stderr remain separate captured evidence.

### Reasoning effort

Agent `config.effort` selects `low`, `medium`, `high`, `xhigh`, or `max`. New editor nodes and generated templates include `medium` explicitly. The field remains optional for existing workflow snapshots; omission resolves to `medium` at dispatch without modifying their saved bytes. Unknown levels are structural errors. Effort is an invocation parameter, like the requested model, and may change between ordered writes to the same Context.

Every fresh and resumed invocation passes the resolved value through Codex `-c model_reasoning_effort="<level>"`, Claude Code `--effort <level>`, or Antigravity `--effort <level>`. The child environment removes `CLAUDE_CODE_EFFORT_LEVEL`, which could otherwise override Claude's command-line setting even in restricted configuration. Invocation manifests and successful `providerResult` records include `requestedEffort`. This is the requested setting, not a claim that the provider reported its effective reasoning level. Historical manifests without this field remain readable.

Changing effort changes execution fingerprints, including dependent Cache fingerprints. Run Node cannot reuse inputs from a run captured before the explicit-effort policy; rerun its branch first. Explicitly frozen Cache pins retain their normal user-selected replay behavior. Historical Gate review fingerprints and Map template generations also become stale on this policy change. Context compatibility is unchanged: fresh and resumed calls both carry the requested effort explicitly.

## Semantic validation beyond JSON Schema

Save accepts structurally valid definitions, including disconnected drafts, and returns all semantic issues. Execution requires no issues. Validate in this order:

1. Unique node/edge IDs and Prompt Template slot IDs; existing endpoints and view IDs; known output/input names; compatible types; exactly one source for every required input.
2. Context references resolve to `context` nodes with the same provider. Continue bindings exist locally and match the workspace, account/configuration, and adapter capabilities.
3. `after` references name executable nodes, not Context declarations; self-dependencies and duplicate After pairs are rejected.
4. Build the directed dependency graph from data edges and After pairs. Reject cycles. Every pair of Agent nodes sharing a Context, or referencing Continue Contexts that resolve to the same binding, must be transitively ordered; an unordered pair is an error, not scheduler-dependent history.
5. Every executable node must lead to a Result Viewer through data edges. Context declarations must be referenced. Node-only/branch execution is deferred to M3; M1 executes the saved DAG.
6. Embedded output schemas compile without external references; requested provider/model/configuration capabilities are supported. Each Agent timeout is between 5 and capabilities.maximumAgentTimeoutSeconds. Provider availability is checked again at dispatch. Model identifiers allow ASCII letters/digits and `._:/[]-`, including bracketed aliases; reject whitespace/control characters or a leading hyphen. Pass arguments as an array, never interpolated shell text.
7. A capabilities response contains exactly one record for each supported provider (codex, claude, antigravity); duplicate provider IDs are a semantic error even when other fields differ.

Semantic errors identify the JSON path and explain the problem. Full Access prevents a static validator from proving filesystem effects; runtime directory locks still apply.

## Scheduler and resource locks

A run has at most one active execution per workspace. Ready nodes dispatch when predecessors succeeded and all resources are available. Capacity belongs to the application, aggregated across **all runs/workspaces** using the same provider/account. The core-v1 workflow has no global/provider limit fields. [application-settings.schema.json](schemas/application-settings.schema.json) defines the persisted application limits; workflow settings contain only native configuration.

| Resource | Reservation |
| --- | --- |
| Global Agent capacity | Default 3; editable 1–16 |
| Provider Agent capacity | Default 1 for each provider; editable 1–8; effective capacity is min(provider limit, global limit) |
| Native conversation | Application-wide single writer for provider/account/native-session identity |
| Canonical working directory | One Agent/tool writer at a time, including different providers |
| Store ownership | One supervised runtime instance owns the database and store |

Application settings start at globalLimit = 3 and providerLimits = 1 for each provider. One supervised runtime owns their counters. The current settings revision is authoritative for dispatch across every workspace. CreateRun captures the initial revision/values in its run-settings manifest. Changing limits is an explicit revision-checked application command: commit the new settings and `run.capacity_changed` events for every nonterminal run before applying them to dispatch. Lowering a limit never kills running calls; new calls wait until occupancy falls below the new cap. Raising it affects later dispatch. A settings snapshot never gives one run a separate capacity allowance.

Acquire all needed resources atomically; never hold a provider slot while waiting for a directory or Context lock. Release only after process termination and output capture. Different copied directories can run in parallel in M5. Calls sharing one ordinary project directory serialize even if provider slots are free. The Context-chain example is intentionally serial.

Separate logical Codex roles still compete for Codex capacity. The reference pipeline is Codex-bound at the default of one call: Customer, Analyst, reviews, and triage queue behind each other. Raising that limit is a visible user setting to test after measuring CLI/account behavior, not a promised safe speedup.

## Context binding and native configuration

A Context definition belongs to a captured workflow; its native binding is a separate local record with a **UUID** everywhere. At plan time, persist `run_context_bindings(run_id, context_node_id, mode, binding_id)`. The run identifies the captured workflow; do not search attempts to discover this mapping. New mode allocates one unbound local binding per run/Context node without a CLI call; its first invocation creates the native session, and subsequent uses in that run share it. A later run allocates another binding. Continue mode maps that run/Context node to exactly the selected existing ready binding. Several historical runs can refer to one continued binding, so mode and run/node scope belong to the mapping, not to the native identity row. Missing/incompatible sessions fail without fresh-session fallback.

An Agent without Context starts a new session per attempt. Changing model within one Context requires verified adapter support. Resume appends to the native conversation's current end and does not rewind to a previous node. External native turns can be unknown to the orchestrator. Context compatibility hashes native profile/account/cwd/adapter settings, while requested model is a separate explicit invocation parameter; model changes must pass the adapter compatibility check. Explicit aliases are recorded as requested; observed resolved models remain null when the provider does not report them.

| Binding state | Trigger | Next state / effect |
| --- | --- | --- |
| `unbound` | First dispatch in new mode | `writing`; reserve identity/cwd and start the adapter |
| `ready` | Authorized ordered invocation or M3 chat | `writing` |
| `writing` | Successful process, valid output, captured native identity | `ready`; commit output and binding |
| `writing` | Canceled/failed/interrupted invocation after native work may have started | `needs_review`; native history may have advanced |
| `unbound/ready/needs_review` | Session missing or incompatible | `unavailable` |
| `needs_review` | User explicitly accepts the observed current native state | `ready` |
| `needs_review/unavailable` | User explicitly selects a fresh binding | Old binding stays historical; new binding starts `unbound` |

Checking availability must not issue a model request. A successful fresh invocation must yield a usable native identity; otherwise continuation is unavailable and the output contract fails. A failure provably before process launch restores a binding temporarily reserved as writing to its captured prior ready/unbound state. If the dispatch check already found needs_review or unavailable, preserve that observed state rather than making it ready.

The visible `nativeConfiguration` setting is `restricted` by default, matching the prototype's suppression of native instruction/MCP settings where supported. `inherit` enables supported native configuration only after the adapter verifies the same subscription/billing guards; unsupported inheritance is an error. Invocation manifests show which native settings/instructions/tool profile were enabled. Full Access is the default access policy in both profiles.

Distinct sessions do not isolate account-level memory, native instructions, extensions, or personal settings. Curated inputs and separate directories control what the engine supplies; they do not establish a security boundary against shared native state.

## Run and attempt transitions

| Current run state | Trigger | Next state |
| --- | --- | --- |
| `queued` | Captured workflow validated and scheduler starts | `running` |
| `running` | Every executable node succeeded and outputs committed | `succeeded` |
| `running` | First failed attempt | `draining`; disable new dispatch, retain running siblings |
| `draining` | All running attempts have finished and committed evidence/outputs | `failed` |
| `queued/running/draining` | Root Stop | `stopping` → `canceled` after all child processes exit |
| Any nonterminal state | Runtime restart or loss of owned process supervision | `interrupted` after recovery inspection |
| Any terminal state | New user execution | New run ID; never mutate/reopen the old run |

M1 has exactly eight run states: queued, running, draining, stopping, succeeded, failed, canceled and interrupted. `waiting_for_user` is reserved for the future M2 scoped-recovery contract; core-v1 rejects it in API payloads, filters, journal transitions and the database. A Context's `needs_review` is an independent binding status, not a run pause.

Continue creation requires a ready compatible binding; needs_review rejects creation with HTTP 422/context_unavailable and creates no run. If a required binding is no longer usable at dispatch, fail that already-planned attempt with context_unavailable before launching a CLI, preserving the observed binding status, and apply the ordinary draining policy. A native failure may therefore produce both draining and needs_review; the failure governs the run while the review status remains captured on the binding. Root Stop and restart retain their canceled/interrupted outcomes. Acknowledgment changes the binding for later explicit runs; it neither reopens a terminal run nor re-enables dispatch in a draining run.

Plan every executable node with an ordinal-1 attempt in `scheduled`, and journal null → scheduled before any dispatch; API snapshots always expose its attempt UUID. Attempt transitions: `scheduled → waiting → running → succeeded/failed/canceled/interrupted`, with scheduled → running allowed when resources are free. Scheduled/waiting → blocked records unavailable predecessor data or the run failure latch; process identity is null. Root Stop makes unstarted attempts canceled. Context declarations have no attempt.

On the first operational failure, terminate/capture only that attempt if it still owns a process. Enter draining atomically with blocking all unstarted attempts. Already running attempts may finish, commit valid outputs and restore their own healthy Contexts to ready. Neither descendants nor newly ready static utilities dispatch while draining. Later sibling failures are also captured; they do not reopen scheduling. Finish failed only after every running attempt and its capture completes. Root Stop during draining still aborts all owned children and finishes canceled, preserving the earlier failure evidence. Static Text/Prompt/Viewer attempts also commit inputs/outputs and terminal events, without consuming provider capacity. A Context node is a declaration and creates no executable attempt.

Timeout is active process time; resource waits are excluded. The UI initializes new Agent configs to 600 seconds. The schema requires a finite integer (minimum 5); semantic validation enforces the advertised maximum, initially 600 in M1. The maximum is an integer capability, not a schema constant. M5 can advertise a larger finite maximum without changing schemaVersion. Existing runs pin the maximum at creation, so later capability changes do not alter their deadline.

Root Stop terminates all running provider trees. Its acknowledgement confirms the request, not completed termination. Record PID/start identity/supervisor generation immediately after launch; never terminate a reused PID with a different start identity. Process containment is defined below.

Authentication, quota, billing-policy, permission, timeout, process, contract, and corruption failures stay distinct. M1 makes no automatic attempt retry. M2 adds explicit same-captured-input retry under [Loop recovery rules](LOOPS.md#failure-and-recovery). After a runtime restart, reconcile journals and processes before releasing stale locks; never issue another provider call automatically.

## Process containment

In target Tauri mode, **Rust** creates and retains a Windows Job Object with KILL_ON_JOB_CLOSE. Its handle is non-inheritable; only Rust owns it, while child processes inherit Job membership. Assign Node to the Job before Node can start a CLI. The implementation launches Node with `--supervised`; Node waits for a `contained` confirmation on stdin, sent only after `AssignProcessToJobObject` succeeds, before it initializes the engine. This handshake is equivalent to a suspended launch. Breakaway is disallowed. Assignment failure blocks runtime startup. Rust closes the Job on application exit or unexpected Node exit and waits for owned descendants to terminate before launching a replacement generation. A Rust supervisor thread watches each runtime generation independently of UI calls: when Node exits unexpectedly it immediately terminates the Job, waits until the Job reports no active process, and emits `runtime-lost` to the window, which reconnects to a new generation (startup recovery marks the lost runs interrupted). Thus losing Node also terminates its CLI children while Tauri remains alive. A failed Job query or termination is uncertainty, never "no processes": Rust then refuses to start another generation and asks the user to close the application, whose exit closes the Job handle (KILL_ON_JOB_CLOSE). No surviving-process adoption path exists in this mode. Root Stop uses owned process-tree termination; it does not close the entire runtime Job. Every path handed to Node (runner script, storage root, connection file) is passed without the Windows verbatim prefix: a canonical `\\?\C:\...` script path makes Node's module loader fail (`EISDIR: lstat 'C:'`), so `\\?\` is removed and `\\?\UNC\server\share` becomes `\\server\share`; a missing bundled runner is reported before spawning.

The standalone browser-development runner (`npm run runner`) has no Rust Job supervisor. It advertises `processContainment = standalone-best-effort`, records owned PID/start identities and uses explicit tree termination on Stop/recovery. On runner loss, children may survive: startup blocks reservations/new calls until matching trees are confirmed terminated or the user resolves uncertain ownership. Never kill a reused PID or silently adopt surviving sessions. This development mode does not satisfy the desktop crash-containment exit criterion. The prototype remains unchanged; the Job and recovery policy are M1 implementation work.

## Native structured-output transport

Provider CLIs accept only a subset of JSON Schema in their native structured-output flags (Codex `--output-schema` uses strict Structured Outputs; Claude and Antigravity `--json-schema` reject root composition). The engine never sends the answer contract itself. It derives a deterministic **transport schema** ([transport.mjs](../runtime/core/transport.mjs)):

- local `$ref`s are inlined; `$defs`, `$schema`, `$id`, `title` are dropped;
- `allOf` refinements are folded into their object; `if`/`then`/`else`, `not`, dependent and unevaluated keywords are dropped;
- a `oneOf`/`anyOf` whose branches are all objects becomes one object (union of properties, enums merged); other unions remain a nested `anyOf`, never at the root;
- every object is closed (`additionalProperties: false`) with every property required; a property the contract leaves optional is sent as nullable and removed again when the answer carries `null`. The prompt explains that fields absent or forbidden in the selected contract branch must be encoded as `null`, and the final response and native finish tool must carry the same value;
- `const` becomes a one-value `enum`; enum-only nodes get an explicit `type`. Only string-valued enums travel natively: numeric, Boolean, null and mixed enums are enforced by the complete engine contract, because Gemini function schemas reject non-string enum members. Optional nullability uses nested `anyOf` with a null branch, preserving string enums inside the non-null branch; Gemini's function conversion can discard null in a `type` array. Only strict-subset keywords are kept (`type`, `properties`, `required`, `items`, `additionalProperties`, `enum`, `anyOf`, `description`, `pattern`, the strict `format` values, `minimum`, `maximum`, `minItems`, `maxItems`);
- the root must be an object. A free-form object, an object with additional properties, or a non-object root cannot be transported.

The prompt still carries the complete contract, and every decoded answer is validated against the complete contract, so dropped rules (for example "a rejection needs a blocker") are still enforced by the engine. A contract that cannot be transported is refused before any model request: as the semantic issue `output.transport` when the workflow is validated, and as an `output_contract` attempt failure at dispatch. The engine never retries in a weaker output mode and never extracts an answer from prose.

Antigravity may concatenate the native JSON answer and a finish-tool echo in `result.response`. Only when its reported `json_schema` equals the requested transport, and every complete JSON-object message equals `structured_output` after removing undeclared string `toolAction`/`toolSummary` protocol fields and applying the same optional-null decoding, may the adapter publish that one structured value. Prose, trailing text, duplicate keys, conflicting messages or a mismatched schema still fail; an earlier structured result never overrides a different current response. Full contract and Gate validation remain mandatory.

## Output capture integrity

- Standard output is decoded as a UTF-8 **stream** (multibyte characters may be split across chunks) and flushed at end of file; raw bytes are captured unchanged.
- Normalization follows the Agent's current output contract. A Text Agent publishes the turn's textual response. A JSON Agent uses a provider's structured field only when it is turn-scoped (Claude) or when the turn has no textual response; when a textual response is present it must itself be the JSON answer, and a conflicting structured value (for example Antigravity repeating an earlier turn's structured output) is rejected as `output_contract` instead of being published.
- Log capture runs in stream callbacks and timers outside the awaited invocation. A storage failure there is contained: the owned process tree is stopped and the attempt fails with `capture_failed` (journal v2, additive), distinct from timeout or provider failure. When the journal itself cannot be written, the runtime refuses new work (`409` on run creation), stops its owned processes and stays up; restart recovery marks the affected runs interrupted.

## HTTP/SSE API

These are **target M1 endpoints**, not a description of the current prototype API. Tauri supervises one Node runtime and passes its ephemeral loopback address/token to the frontend. Bind to `127.0.0.1`, authenticate every endpoint, and check allowed Origin. No provider secrets enter the frontend.

Use [runtime-api.schema.json](schemas/runtime-api.schema.json) `$defs` for JSON payloads. Responses use JSON except artifact bytes and SSE.

| Method / path | Request | Success |
| --- | --- | --- |
| `GET /api/v1/capabilities` | None | 200 `capabilities`; detection only, no model call |
| `GET /api/v1/settings` | None | 200 `applicationSettings` |
| `PUT /api/v1/settings` | `updateApplicationSettings` | 200 `applicationSettings`; expected revision and idempotent request ID |
| `GET /api/v1/workspaces?limit=&cursor=` | `listQuery` | 200 `workspaces` |
| `GET /api/v1/workflows?limit=&cursor=` | `listQuery` | 200 `workflows` |
| `GET /api/v1/runs?workspaceId=&state=&limit=&cursor=` | `runListQuery` | 200 `runs`; includes failed/canceled/interrupted history |
| `PUT /api/v1/workspaces/{workspaceId}` | `workspaceRequest`; existing absolute cwd from desktop picker | 200 `workspace`; reject protected paths or rebinding an active workspace |
| `GET /api/v1/context-bindings?workspaceId=ID` | Existing workspace ID | 200 `contextBindings`; local opaque bindings |
| `POST /api/v1/context-bindings/{bindingId}/acknowledge` | `acknowledgeContext`; exact observed binding digest | 200 `contextBinding`; explicitly accept needs_review state, never invent missing history |
| `PUT /api/v1/workflows/{workflowId}` | `workflow.schema.json`; ID must match path | 200 `savedWorkflow` including snapshotSha256, executionHash and semantic issues |
| `GET /api/v1/workflows/{workflowId}` | None | 200 `savedWorkflow` |
| `POST /api/v1/workflows/validate` | `workflow.schema.json` | 200 `validation`; no save/execution |
| `POST /api/v1/runs` | `createRun` | 202 `acceptRun`, after durable capture |
| `GET /api/v1/runs/{runId}` | None | 200 `runSnapshot` |
| `POST /api/v1/runs/{runId}/stop` | `stopRequest` | 202 `stopResponse` or 200 if already terminal |
| `GET /api/v1/runs/{runId}/events?afterSequence=N` | Nonnegative cursor, default 0 | SSE of durable events with sequence > N |
| `GET /api/v1/artifacts/{artifactId}` | None | 200 verified bytes, recorded media type, `ETag` = quoted SHA-256 |

CreateRun pins `savedWorkflow.snapshotSha256` through `workflowSnapshotSha256` and the workspace binding. Its run-settings artifact validates as `runtime-api.schema.json#/$defs/runSettings`: initial application settings/revision, workflow native profile, advertised timeout maximum, supervision mode and canonical workspace identity. A mismatch or active run in that workspace returns 409. AcknowledgeContext requires no active writer and verifies the observed digest; it records the user's acceptance of the uncertain native state for later runs. It cannot make an unavailable session available. Command identity includes method/action and target IDs. Its payload digest uses canonical JSON. Command `requestId` is a UUID: repeating the same command/payload returns its original response; reuse with a different payload returns 409. Stop is idempotent even after completion. PUT replaces the draft atomically and does not mutate any captured run.

List endpoints use default limit 50 (maximum 200), ordered by immutable createdAt descending, then ID descending. nextCursor is null at the end; otherwise it is an opaque runtime-issued cursor pinning collection/filter values, the first-page upper (createdAt, ID) fence, and the last tuple returned. Seek strictly below the last tuple and at/below the fence. Later inserts are excluded; mutable summaries and state filters reflect each request's current committed state, so this is not a frozen database snapshot. Malformed/foreign/filter-mismatched cursors return 400. An unknown workspace filter returns 404. Run recovery/history can be discovered from the lists without retained frontend IDs. Run summaries include workspaceId; runSnapshot includes captured Context mappings.

Error body is `problem`: 400 malformed request, 401 authentication, 404 unknown ID, 409 conflict, 422 structural/semantic/capability validation, 500 corruption/internal failure. Provider failures after creation are journaled run outcomes, not a later HTTP creation failure.

SSE: event name `journal`, `id` is the decimal run sequence, `data` is one validated [journal envelope](schemas/journal-event.schema.json). Cursor reconnect returns stored events before tailing live commits. `Last-Event-ID` is accepted when the query cursor is absent; conflicting cursors return 400. A cursor beyond the last sequence returns 409. Keepalive comments carry no state. Terminal runs close after all stored events are sent; reconnecting remains readable. There are no ephemeral state transitions outside the journal.

## Later reruns and Context chat

M3 execution selections are explicit Workflow/Branch/Node targets. Branch/Node uses captured upstream values only when they are valid for the selected generation. Required After prerequisites remain live unless already proved by the exact stored execution. Changing semantic inputs invalidates actual consumers, while view edits do not.

Frozen Cache replays data; it cannot recreate skipped native turns or filesystem effects. A consumer sharing Context with a skipped writer requires proof that the native binding includes that writer's committed turn. If proof is absent, run the prerequisite or require a new Context. Chat acquires the same native/cwd locks and journals the turn; it makes affected in-flight plans stale and never slips between ordered scheduled Agent writes.
