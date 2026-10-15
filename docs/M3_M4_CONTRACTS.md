# M3 and M4 Execution Contracts

Version: 0.11
Status: concrete M3/M4 contract package; implemented with M3 and M4
Updated: 2026-10-13

This is the normative home for the Cache node and rerun planning (`cache-v1`), manual Context chat, and the documentation-approval primitives (`pipeline-v1`): Gate, Route, selected Merge, nested Loops, specification bundles, role views, structured reviews and the issue ledger. Everything not changed here keeps its definition in [M1 contracts](M1_CONTRACTS.md) and [M2 contracts](M2_CONTRACTS.md). Selective cross-revision carry remains M6.

## Versioning

| Asset | Change |
| --- | --- |
| Workflow | `capabilities` starts with `core-v1` and may add `loops-v1`, `cache-v1` and `pipeline-v1` in any order, each at most once. `pipeline-v1` requires `loops-v1`. Node types are gated by capability, structurally (Cache needs `cache-v1`; Gate and Route need `pipeline-v1`) and semantically (`capability.cache`, `capability.pipeline` for selected Merge and nested Loops). |
| Journal v2 | Additive: attempt states `reused` and `skipped`, nested scoped instance IDs, error codes `route_unmatched` and `context_prerequisite`, and the events listed below. Every event valid before stays valid. |
| API v2 | Additive: `createRun` options (`mode`, `targets`, `refreshCaches`), cache pins, chat turns, `run.kind`. |
| Database | [Migration 3](storage/m3.sql): attempt/node-instance states `reused` and `skipped`; `runs.kind` and `runs.plan_json`; `workflows.kind`; tables `cache_pins` and `pipeline_records`. |

## M3 — Cache

| Type | Config | Inputs | Outputs |
| --- | --- | --- | --- |
| `cache` | `valueType`, `mode: live | frozen` | `value` of `valueType` | `value` of `valueType` |

- **Live** passes the committed upstream value through unchanged and records it as this attempt's output.
- **Frozen** emits the value pinned for this workflow and node (the `cache_pins` table) and journals `cache.reused` with the pin's source run and attempt. The planner removes the Cache's *data* input edge from dependency traversal for that run. A producer still runs if any other planned consumer or a required After dependency needs it. A frozen Cache without a pin, or with a pin whose artifact digest no longer verifies, rejects run creation (422 `validation_failed`).
- **Pinning** is explicit. `PUT /api/v2/workflows/{id}/cache-pins/{nodeId}` with `freezeCacheRequest` (`runId`, `nodeInstanceId`) pins the committed output of a succeeded Cache attempt. A run created with `refreshCaches: [nodeId]` treats those Frozen Caches as Live for that run and, when the Cache attempt succeeds, replaces the pin (`cache.pinned`). A failed refresh keeps the previous pin.
- A pin records its value, source run/attempt, and the source run's node fingerprint. When the current fingerprint differs, `GET …/cache-pins` reports `sourceChanged: true`. Nothing is unfrozen or replaced automatically.
- **Inside a loop**, a Frozen Cache supplies the same pin on every iteration. A Cache whose output reaches `$return.decision` is rejected [`cache.decision`]: the decision must be evaluated live.
- A frozen hit restores no native turns, files or tool effects (see Context prerequisites below).

## M3 — Run targets and stale inputs

`createRun` accepts an optional `mode`:

| Mode | Targets | Plan |
| --- | --- | --- |
| `workflow` (default) | every Result Viewer | All ancestors, with frozen-Cache cuts |
| `branch` | `targets` (outer node IDs) | The targets and their ancestors, with frozen-Cache cuts |
| `node` | exactly one outer node | Only the target runs. Each direct predecessor is **reused** from the most recent run of this workflow whose captured predecessor has the same fingerprint and a succeeded attempt |

A **node fingerprint** is the SHA-256 of the node's canonical definition, the fingerprints of its data and After predecessors (with ports), its loop body, and its Cache pin. View data is excluded. A reused predecessor is planned with an attempt in state `reused` whose outputs reference the source attempt's committed manifest (`attempt.reused` event). A missing or stale predecessor rejects creation (422 `validation_failed`, path of the predecessor). Nodes outside the plan are not planned at all; the run snapshot omits them and they never appear as succeeded.

**Context prerequisites** [`context_prerequisite`]: when an unplanned or reused Agent shares a Context node with a planned Agent, creation is rejected unless that Context is `mode: continue` and its binding is the one recorded on the reused attempt. A fresh Context cannot stand in for a skipped writer's turns. Required After predecessors are planned (branch) or must be reused from a succeeded attempt with the same fingerprint (node).

The captured `run.plan_json` records mode, targets, refreshed Caches, the pins used and each reuse source. It is part of the run settings manifest (`runSettings` gains no fields; the plan is a separate artifact referenced by `run.created`).

## M3 — Context chat

`POST /api/v2/context-bindings/{bindingId}/messages` with `chatRequest` (`requestId`, `workspaceId`, `model`, `prompt`, optional `effort` and `timeoutSeconds`) creates a run of `kind: chat`. Effort follows the [Agent effort contract](M1_CONTRACTS.md#reasoning-effort); the generated Agent captures the resolved level explicitly, and the chat editor offers the same selector. Its captured workflow is a generated core-v1 graph (Text → Agent with a `continue` Context on that binding → Result Viewer) under the system workflow `context-chat`, which workflow lists hide. Consequences:

- The turn uses the same adapter, locks, journal, timeout and recovery as any run. It requires a `ready` binding (422 `context_unavailable` otherwise) and no active run in the workspace (409).
- Responses are `acceptRun`; the transcript is the list of chat runs for that binding (`GET /api/v2/runs?kind=chat&bindingId=…`).
- A manual turn advances the native conversation. Later Continue runs append after it, and node-mode reuse never treats a chat answer as a graph output. To use one downstream, pin it through File / Artifact Input.

## M4 — Route and selected Merge

| Type | Config | Inputs | Outputs |
| --- | --- | --- | --- |
| `route` | `valueType`, `selector` (JSON Pointer), `cases` (`id` + `equals` literal, at least one), `onUnmatched: error | pause` | `selector: JsonValue`, `value` of `valueType` | one output per case ID, of `valueType` |
| `merge` with `mode: selected` | `valueType`, ordered `inputs` | one per input | `value` of `valueType` |

- Route evaluates the pointer without coercion. Exactly one matching case activates its output (`route.selected`); more than one match is an `output_contract` failure. No match fails with `route_unmatched`. With `pause`, the run then waits for the user like any failure; with `error`, the message marks it as a contract error.
- An output that Route did not select is **inactive**. A node with any inactive required input, or whose data predecessor is `skipped`, becomes `skipped` instead of running. Skipped work has no outputs and no fabricated success. An After predecessor that was skipped satisfies the order constraint.
- **Selected Merge** follows the [decision table](PIPELINE_EXECUTION.md#route-and-selected-join): exactly one succeeded alternative with every other inactive → commit its value; all inactive → `skipped`; any unresolved → wait; more than one active → `output_contract` failure; a failed active alternative holds the join for recovery.
- A run succeeds when every planned outer instance's latest attempt is `succeeded`, `reused` or `skipped`.

## M4 — Nested Loops

Loops may contain Loops up to depth 3 (`loop.depth` beyond that). Scoped instance IDs repeat the pattern `<loop>/<iteration>/` per level, for example `delivery/2/spec/1/analyst`. Loop executions are keyed by the loop's own instance ID. Every `loopNodeId` field in the journal and API (loop events, `scope`, run snapshot loops, recovery requests) carries that scoped loop instance ID, for example `delivery/1/specification`. An inner loop is an ordinary body node of its parent iteration. Active time of a body attempt counts towards every enclosing loop (union per loop). Root Stop, a scoped Stop on a loop, and `close` cascade to every descendant. Recovery commands name the scoped loop instance ID.

## M4 — Specification bundles, views and Gate

A **specification bundle** is an ArtifactSet that contains `spec-index.json` (valid against [the section index schema](schemas/spec-section-index.schema.json)), the Markdown `document` it names, and optionally `implementation-map.json` (valid against [the map schema](schemas/implementation-map.schema.json)). Bundle validation applies the parsing rules in [Pipeline execution](PIPELINE_EXECUTION.md#specification-bundle-and-section-index): exact `## ID` headings outside fences, one heading per indexed section and none unindexed, resolved acyclic `dependsOn`, and mandatory REQ-/CONTRACT-/CHECK- prefixes. The **subject ID** is `SPEC-` followed by the first 12 uppercase hex digits of the bundle manifest's SHA-256, so an unchanged bundle always has the same subject.

Gate has three modes. The `policy` is the same object for all three (`slots`: `id`, `role`, `view: full | public`), and its canonical hash is the **policy fingerprint**.

| Mode | Inputs | Outputs |
| --- | --- | --- |
| `prepare` | `subject: ArtifactSet`, `issues: JsonValue` (open issue list) | `subject: ArtifactSet` (the validated bundle), `plan: JsonValue` ([reviewPlan](schemas/gate.schema.json)), one ArtifactSet view per slot ID |
| `evaluate` | `subject: ArtifactSet`, `plan: JsonValue`, one `JsonValue` per slot ID | `report: JsonValue`, `certificate: JsonValue` (record reference or `null`) |
| `verify` | `subject: ArtifactSet`, `certificate: JsonValue` (record reference or `null`) | `report: JsonValue` |

- **Views.** A `full` view contains the whole bundle plus `SUBJECT.json` (`subjectId`, `slot`, `role`, `policyFingerprint`). A `public` view contains `SUBJECT.json` and a materialized `SPEC.public.md` with only normative public `business`, `requirement` and `acceptance` sections, plus their filtered index. Internal contracts, checks, the map and source stay out. Views restrict supplied material only; they do not isolate shared provider memory.
- **Reviews.** Every slot input must come directly from an Agent's `json` port [`gate.review-source`]. The engine validates each decision against [review-decision.schema.json](schemas/review-decision.schema.json) and checks the semantic rules: `subjectId` equals the plan's; `role` equals the slot role; CHANGES_REQUESTED has at least one blocker; APPROVED has none; local IDs are unique; `resolvedIssueIds` name open issues owned by that slot's role. A violation fails the Gate attempt with `output_contract`; it is never turned into a rejection. Each accepted decision is stored as a `ReviewRecord` with the reviewer's node instance, attempt and requested/observed model.
- **Issue ledger.** New issues get global IDs `ISS-` + the first 10 uppercase hex digits of SHA-256(subjectId, slot, localId). Open issues after evaluation are the plan's open issues minus the resolved ones, plus the new ones. Every issue keeps the shape of the [pipeline-state issue](schemas/pipeline-state.schema.json) record.
- **Issue ownership and imported issues.** An issue whose ID is in a slot's namespace (`ISS-<SLOT>-…`) belongs to that reviewer: only that slot may resolve it, and a claim by any other slot fails `output_contract`. An issue in a namespace that no slot of the current policy owns was imported, for example `ISS-MAP-…` from a Map or triage specification revision, or an issue raised under another Gate's policy. A live slot may resolve an imported issue when its review scope (its `scopeRefs`, or its view's normative sections, with their transitive dependencies) covers every requirement the issue cites; an issue that cites no requirement needs a full view without `scopeRefs`. The issue keeps its ID, message and evidence. Prepare lists each slot's authorized IDs as `resolvableIssueIds` in the plan, and evaluate recomputes the authorization from the subject itself rather than trusting the plan input.
- **Report.** `status` is `OPEN` when every slot approved and no open blocker remains; otherwise it is `REVISION_REQUIRED`. The report also carries `subjectId`, `reason`, the open `issues`, and `certificate`.
- **Certificate.** An OPEN evaluation writes a `GateCertificate` record pinning the subject manifest, the policy fingerprint and every review record, and emits a `recordId` plus artifact reference. Only the engine creates records (`pipeline_records`); a JSON value shaped like a certificate but not stored with that digest is rejected by `verify`.
- **Verify** returns `OPEN` (with the certificate) only if the record exists, its digest matches, its subject manifest equals the input subject's and its policy fingerprint equals this Gate's. A `null` or stale certificate gives `REVISION_REQUIRED`; a corrupt record is an operational `corruption` failure. Verify never calls a model.
- **Whole-subject re-review.** Through M5, every new revision is reviewed by every slot. The Specification Loop body has no review-skipping path; only an exact unchanged, already-approved subject bypasses drafting, through `verify` + Route outside the loop.

The [M4 reference workflow](examples/m4-specification-loop/workflow.json) wires the [Specification Loop](TEST_PIPELINE.md#specification-loop-wiring) with these primitives and is the M4 exit fixture.

## Journal v2 additions

| Event | Payload |
| --- | --- |
| `attempt.reused` | `sourceRunId`, `sourceAttemptId`, `outputs` manifest reference |
| `cache.reused` | `nodeId`, `pin` (value), `sourceRunId`, `sourceAttemptId` |
| `cache.pinned` | `nodeId`, `pin` (value), `sourceRunId`, `sourceAttemptId` |
| `route.selected` | `caseId` (or `null` when unmatched), `selector` value reference |
| `gate.evaluated` | `mode`, `subjectId`, `status` (or `null` for prepare), `recordId` (or `null`) |
| `run.planned` | plan artifact reference, `mode`, `targets` |

## Records

[gate.schema.json](schemas/gate.schema.json) defines `reviewPlan`, `report`, `recordRef`, `reviewRecord`, `certificate` and `subjectView`. Records are immutable artifacts indexed in `pipeline_records(id, run_id, kind, artifact_id, created_at)` and verified on read.
