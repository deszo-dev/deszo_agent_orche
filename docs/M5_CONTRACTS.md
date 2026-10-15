# M5 Contracts — Implementation Map Delivery

Version: 1.0  
Status: implemented contract package for M5  
Updated: 2026-10-13

This is the normative home for the Implementation Map node (`delivery-v1`), its engine task templates, TaskResult/Candidate/Conflict/CheckReport/Triage/MapState records, the verification-cycle bound and the basic navigator. Concepts and motivation stay in [Implementation Map](IMPLEMENTATION_MAP.md) and [Pipeline execution](PIPELINE_EXECUTION.md). Everything not changed here keeps its definition in the [M1](M1_CONTRACTS.md), [M2](M2_CONTRACTS.md) and [M3/M4](M3_M4_CONTRACTS.md) contracts. Cross-revision carry, per-reviewer Routes and generated-history canvases remain M6.

## Contract package

| Artifact | Change |
| --- | --- |
| Workflow | Capability `delivery-v1` (requires `pipeline-v1`) and node type `map` ([workflow.schema.json](schemas/workflow.schema.json) `mapNode`). Semantic codes `capability.delivery`, `map.roles`, `map.context`. A Context named by a Map role counts as used and takes part in `context.unordered`. |
| Map records | [map.schema.json](schemas/map.schema.json): Agent answers `taskReturn`, `taskReview`, `triageDecision`; the `mapRepair` input; engine records `taskResult`, `taskReviewRecord`, `checkReport`, `candidate`, `conflict`, `triage`, `mapState`; the `summary` output and the `navigator` projection. |
| Journal v2 | Additive events `map.expanded`, `map.task_state_changed`, `map.record_created`, `map.verification_cycle`, `map.paused`, `map.resumed`, `map.limits_changed`, `map.finished`; recovery action `raise-map-limit`. |
| API v2 | Additive `GET /api/v2/runs/{runId}/maps/{mapInstanceId}` → `mapNavigator`; `runSnapshot.maps[]` (`mapExecution`); recovery action `raise-map-limit` with `nodeInstanceId`, `maxFailedVerificationCycles`, `maxTaskAttempts`. |
| Storage | [Migration 4](storage/m4.sql): `pipeline_records` accepts the M5 record kinds; new `map_executions` and `map_tasks`. |
| Fixtures | `m5-*` cases in [the manifest](fixtures/manifest.json) and [invalid cases](fixtures/invalid/cases.json), [payloads](fixtures/valid/m5-payloads.json), [SQL cases](fixtures/sql-cases-m4.json), and the existing `verificationCycles` decisions. |
| Example | [Round-recovery delivery](examples/m5-delivery/workflow.json) over the [round-recovery bundle](examples/round-recovery/SPEC.md) and the prepared [toy project](examples/round-recovery/project/src/api.mjs). |

## Map node

| Port | Type | Meaning |
| --- | --- | --- |
| `documentation` | ArtifactSet | Exact bundle with `SPEC.md`-style document, `spec-index.json` and `implementation-map.json` |
| `approval` | JsonValue | Gate certificate reference; verified with the same rules as Gate verify under `approvalPolicy` |
| `base` | ArtifactSet | Captured project base |
| `prior-state` (optional) | JsonValue | `MapState` record reference or null |
| `repair` (optional) | JsonValue | `MapRepair` request or null |
| `result` output | ArtifactSet | The accepted candidate tree on completion; an empty set on a revision outcome |
| `summary` output | JsonValue | `MapSummary` |

Config: `approvalPolicy` (Gate policy slots), `optionalInputs` (subset of `prior-state`, `repair`), `limits` (`maxFailedVerificationCycles`, `maxTaskAttempts`, 1–20) and the pinned role registry `roles`:

- **Agent role**: `id`, `kind: agent`, `provider`, explicit `model`, `effort`, `instructions`, `timeoutSeconds`, `context` = `"task"` (a fresh binding per run, Map execution, task and role, in that role's stable task directory) or `{ "contextId": … }` (a visible Context node; the role runs in the workspace directory, like that Context's other writers). Effort follows the [Agent effort contract](M1_CONTRACTS.md#reasoning-effort), including the `medium` compatibility default. Executor, review and embedded triage steps forward their pinned role's effort to the CLI and invocation evidence. It participates in role/template/task fingerprints. Map template version 2 invalidates selections captured before explicit effort was supported.
- **Utility role**: `id`, `kind: utility`, `template: verification`, `embeddedRoles.triage` = an Agent role ID. It has no own model or session.

Start-up order: verify the certificate (exact subject and policy; anything else fails `output_contract`), parse the bundle ([section rules](PIPELINE_EXECUTION.md#specification-bundle-and-section-index)), validate the map with the [documented rules](IMPLEMENTATION_MAP.md#canonical-task-json-and-validation) plus the template-port rules below, then expand. The runtime validator and `docs/tools/validate_docs.py` share issue codes.

Template ports (`template.ports`): an Agent-executed task captures `fileSet` outputs only and its check criteria use `source: task-result`. The verification template needs accepted dependencies, exactly one `candidate` output plus optional `json` reports, and only check criteria with `source: candidate`.

## Generated steps

Each Map execution has a run-local sequence number `n`. Every engine step is an ordinary node instance `"<map instance>/<n>/<task-id-lowercase>-<step>"` (longer names are truncated with a hash), with attempts, locks, capacity, journal, Stop and Retry. `node.planned.scope` names the Map instance and `n`.

| Step | Kind | Behavior |
| --- | --- | --- |
| `execute` | Agent (executor role) | Materializes base + pinned dependency results in the task directory once per input epoch; answers `taskReturn`. A `candidate` answer is captured: every changed path must match `writeScopes`, every declared output must exist, deletes are rejected. Operations are `create` or `replace` (preimage = materialized content). Any violation fails the attempt `output_contract`. |
| `review-<criterion>` | Agent (criterion role) | Reviews a fresh copy of base + dependencies + the result; `taskReview` must name the exact task, result and criterion. |
| `check-<criterion>` | Test Runner | Runs the indexed command (argument array, no shell; `node` resolves to the runtime's Node) in a disposable copy of the task-result tree or the candidate, with the Node test-runner and option variables removed from the environment. Exit ≠ required is a *failed* CheckReport; spawn failure, timeout, signal or source modification outside new write-scope files is an operational failure. |
| `assemble` | Static | Applies selected results over the base. Different content, preimage mismatch or case collision → `Conflict` record; otherwise `Candidate`. No last-writer-wins. |
| `triage` | Agent (embedded role) | Receives failed-check tails and conflicts; answers `triageDecision`. Repair targets must be the verification task's dependencies. |

Task states follow [the task table](IMPLEMENTATION_MAP.md#lifecycle-and-task-state). A result is accepted when every criterion passed for that exact result; failed criteria give `needs_changes` with the blocker issues as feedback for the next attempt in the same directory and Context. Reaching `maxTaskAttempts` blocks the task and pauses the Map (`task_attempt_limit`).

A TaskReview evaluates the named criterion on that task-result snapshot. A parallel test-writing task need not contain implementation modules from tasks it does not depend on. Its source review checks required cases and compatibility with the specified interfaces; candidate-sourced commands run on the assembled candidate in verification. Missing declared inputs and genuine source defects remain blockers. A TaskReview cannot replace the required engine CheckReports for the complete candidate.

## Verification cycle

One cycle = one Assemble over one pinned input set plus its checks. A conflict or at least one failed check increments `failedVerificationCycles` once (`map.verification_cycle`); a passing cycle does not reset it. When the count reaches the limit the Map pauses (`verification_limit`) **before** triage or another cycle; a cycle that would start at the limit pauses the same way. Below the limit triage runs:

- `implementation`, `tests`, `integration_conflict`: the targets get `needs_changes` with the triage issues; their transitive consumers become `stale`; other selections stay accepted.
- `specification`: the Map finishes after its running steps with outcome `specification_revision_required` and the triage issues.
- `unknown`: the verification task is blocked and the Map pauses (`triage_unknown`); Retry on the triage step resumes it.

An executor may also return `specification_revision_required` (issues owned by `analyst`). `raise-map-limit` resumes a limit pause; limits only rise.

The triage decision's `subjectId` is the approved specification ID. The runtime pins that exact value in the provider's native output schema and the full output contract, then still verifies it before committing a Triage record.

## Prior state, repair and generations

A Map writes a `MapState` record on every pause and finish; the summary references it. With `prior-state`:

- Same subject ID **and** same template fingerprint (roles, approval policy and engine template version): same generation; accepted selections are carried unless a repair targets them or one of their dependencies; the failure counter and its raised limit are kept.
- Otherwise: generation + 1, nothing is carried and the counter starts at 0.

`repair` must be a `MapRepair` for the current subject naming existing tasks. Targets start in `needs_changes` with its issues; their consumers start `waiting`.

## Outcomes and lifecycle

`implementation_complete`: every task accepted; `result` = the candidate tree (or, without a verification task, the selected results assembled over the base); `summary.issues` is empty and `summary.checks` lists the CheckReports behind the selected results. `specification_revision_required`: `result` is empty and `summary.issues` is non-empty. Both commit outputs and succeed the Map attempt; downstream Routes use `summary /outcome`.

Pauses move the Map attempt to `waiting` and the run to `waiting_for_user`. Root Stop and `close` cancel the Map execution and its unstarted steps; restart recovery marks it `interrupted`. Operational step failures use the M2 draining/recovery lifecycle.

Retry of an Agent Map step applies the [M2 binding choices](M2_CONTRACTS.md#recovery-and-scoped-stop) to the exact role and task epoch used by that step, including a visible shared Context. It cannot acknowledge another role's conversation. `fresh` remaps only a New binding and preserves the old conversation; a Continue binding refuses that choice. An unusable `keep` choice is rejected before a new attempt is planned. Utility steps accept no binding choice.

## Final delivery acceptance

A Map completion or green checks alone are not success. The reference scenario ends with an engine certificate for the current specification, candidate, passing reports, technical approvals and final Customer approval. Gate prepare with `subject: "delivery"` (requires `delivery-v1`; prepare only; no `carry`) builds that subject from engine evidence only:

| Input | Verified |
| --- | --- |
| `documentation`, `approval` | The specification certificate verifies for that exact bundle under `specificationPolicy` |
| `summary` | A MapSummary with outcome `implementation_complete` for the same specification. Its stored MapState is the **selection proof**: it must be completed, list every task of the approved map as accepted with a stored TaskResult of that task, and record each accepted task's criterion evidence. The summary's selected results must equal those selections |
| `candidate` | The Candidate recorded in the selected verification TaskResult; it must be assembled from exactly the selected dependency results, and the summary's candidate and the candidate files must be that record and its manifest |
| (checks) | For every check criterion of the approved map, the CheckReport named by the MapState's criterion evidence: it passed with intact sources, ran the approved command (arguments, timeout, required exit, source kind), and checked the selected Candidate or the task's selected TaskResult. Separate check references in the summary are not trusted |
| `technical` (when `technicalPolicy` is configured) | A stored GateCertificate for this exact delivery subject under `technicalPolicy` |
| `issues` | Open issues, as for a specification Gate |

The subject is a deterministic ArtifactSet (`DELIVERY.json`, `specification/…`, `candidate/…`, `checks/<criterion>.json`) with ID `DLV-` + its manifest digest; rebuilding from the same evidence gives the same subject, so the final Customer prepare can require the technical certificate for exactly what the technical reviewers approved. Full views carry the whole subject; public views carry the public specification sections and the check summaries, with no source or internal contracts. The resulting certificate has `subjectKind: "delivery"` and `prerequisites` (the specification certificate, then the technical certificate).

The [reference Delivery Loop](examples/reference-delivery/workflow.json) wires the complete scenario of [the test pipeline](TEST_PIPELINE.md#delivery-loop-wiring): verify/bypass or the Specification Loop, the Map with prior state and repair inputs, final technical review (quality and conformance), final Customer acceptance, and on rejection an Analyst triage (`repair-tasks` builds a MapRepair from the rejecting Gate's issues; `revise-specification` reopens documentation), returning through the Loop until `finalAcceptance` is recorded. `runtime/tests/reference.test.mjs` runs both rejection paths to acceptance on fixtures.

## Navigator

`GET /api/v2/runs/{runId}/maps/{mapInstanceId}` returns the latest execution: state, pause reason, cycle counter and limits, accepted/total/waiting/running/blocked counts and, per task, definition, readiness reason, attempts, selected result, carried flag, criterion verdicts with record IDs, step instances and open issues. It never invokes a provider.
