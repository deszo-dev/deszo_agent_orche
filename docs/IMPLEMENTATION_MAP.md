# Implementation Map

Version: 0.7  
Status: confirmed concept; proposed M5/M6 contracts  
Updated: 2026-10-13

The Implementation Map is a node and a progress navigator for implementation/testing. Its canonical JSON is part of the specification used to write code. Analyst drafting, documentation approval, and final business acceptance stay in the surrounding pipeline.

## Three records

| Record | Owner | Meaning |
| --- | --- | --- |
| Documented map | Specification author | Stable task definitions/dependencies/criteria; immutable once captured |
| Map execution | Engine | Approved revision, pinned templates/inputs, selections, acceptance/attempt facts |
| Navigator projection | UI | Current/historical graph/list and progress derived from those records |

No runtime status/provider/session/timestamp is written back into map JSON. Changing task semantics creates a specification revision; moving cards only changes a view. A draft map can be previewed without invoking implementers.

## Node boundary and templates

| Port | Type | Meaning |
| --- | --- | --- |
| `documentation` | ArtifactSet | Exact approved bundle containing typed section index and map |
| `approval` | JsonValue | Engine-verifiable documentation Gate certificate for that bundle |
| `base` | ArtifactSet | Captured project base, including an explicitly declared empty base if appropriate |
| `priorState` | Optional JsonValue | Exact stored map-state reference; never an arbitrary copied status table |
| `repair` | Optional JsonValue | Typed request/evidence targeting selected tasks in the same approved subject |
| `result` output | ArtifactSet | Captured candidate, task/check evidence and outcome manifest |
| `summary` output | JsonValue | Execution/generation/spec IDs, selected result IDs, state reference, issues, outcome |

The summary's mandatory semantic fields are schemaVersion, mapExecutionId, generation, specificationId, outcome, state (stored record reference), selectedResults, issues, candidate (nullable ArtifactSet reference) and checks (actual verification record references). The result manifest binds the same identities and evidence. Their full strict schema is required before M5 coding.

Normal outcomes are `implementation_complete` (all tasks accepted) and `specification_revision_required` (validated issue returns to Analyst). An operational failure pauses/blocks the scope rather than returning a fabricated normal outcome. Actual failed verification is handled **inside Map** by its verification template and typed triage; it is not an accepted TASK-VERIFY or a completed map.

Role registry entries distinguish `kind: agent` from `kind: utility`. Agent entries bind provider/model/instructions/Context/output contract; utility entries bind engine templates such as Assemble → Test Runner → triage and explicitly declare any embedded Agent roles under [registry rules](PIPELINE_EXECUTION.md#role-views-and-registry). Candidate production is supported only by a utility template exposing the typed engine output, not inferred from a role named "verification".

Every task template must fulfill all declared outputs and criteria. Its Task Input receives task definition, specification sections, base/dependency snapshots, feedback/issue IDs, and captured Context/resource bindings. Task Return has three variants: candidate, repair_requested, specification_revision_required. Required envelope/schema fields are a [pre-M5 prerequisite](MILESTONES.md#contracts-required-before-each-milestone); these names alone are not a usable serialized template.

## Canonical task JSON and validation

Use [implementation-map.schema.json](schemas/implementation-map.schema.json) and [the complete example](examples/round-recovery/implementation-map.json). Task fields are id/title/executorRole, requirementRefs, dependsOn, named inputs/outputs, readScopes/writeScopes, and acceptanceCriteria.

`requirementRefs` names normative REQ-/CONTRACT- IDs. Inputs use `spec:ID`, `base:project`, or `task:TASK-ID:output-id`. A `spec:CHECK-ID` input is deliberately allowed when its configured check is needed; it is not a requirementRef. Criteria distinguish reviewing roles from CHECK- IDs.

M5 dependencies require `milestone: accepted`. Early `result_available` consumption is deferred: it is unused by the reference scenario and would need additional selection/invalidation contracts. A producer's acceptance cannot depend on later consumer acceptance.

| Output kind | Contract |
| --- | --- |
| `fileSet` | Concrete relative capture paths within the task's writeScopes |
| `text / json` | Typed data captured from the template; does not become trusted engine evidence merely by matching a shape |
| `candidate` | Derived engine snapshot from Assemble, with concrete candidate paths. It is not a write to the task directory and requires an engine-producing utility template |

Validate schema, then unique IDs, referenced roles/criteria/sections/tasks/outputs, acyclic dependencies, and compatible template ports. Every task-output input needs a matching accepted dependency.

Compute typed normative dependency closure using [the section index](PIPELINE_EXECUTION.md#specification-bundle-and-section-index). Roots are requirementRefs, **all declared spec inputs**, criterion check IDs, and checks whose command arguments name a task output path. Require every root/transitive dependency through explicit spec inputs/readScopes. For each fileSet output, compare normalized relative paths with complete positional argument strings in every indexed check command; a match requires that check in the producing task's closure. No shell parsing/glob expansion is inferred. Commands with indirect/generated paths need an explicit dependency declaration in the pre-M5 check contract and cannot claim inferred coverage. Reject incomplete scope rather than treating undeclared text as safely unchanged.

Thus TASK-AUTH-TESTS receives CHECK-AUTH as well as its syntax check, and TASK-RESUME-TESTS receives CHECK-RESUME. Their fingerprints include those case lists and dependencies even though functional execution is a later TASK-VERIFY criterion. A changed normative test-case section cannot carry an old test-author result at M6.

Normalize paths: no absolute/parent traversal, empty components, ambiguous case collisions, symlink/junction escapes, or globs in capture outputs. Globs are permitted only in declared scope matching. Reject outputs outside write scopes except the explicitly typed derived candidate kind. Missing new outputs fail capture; intended deletes require a base preimage and reviewed delete operation.

Coverage/independence and requirement prose still need readiness review. Full Access does not enforce these scopes as a sandbox.

## Scheduling, selection, and repair

A ready task pins accepted dependency result IDs/hashes and template revision. No task dependency means potential parallelism; actual dispatch uses [the scheduler](M1_CONTRACTS.md#scheduler-and-resource-locks).

Copies are provisioned per task; executor, reviewer, and checker have separate directories. Task author/reviewer Context instances are per run/map/task/role. Embedded utility invocations resolve their declared registry Context policy; the reference Analyst triage uses the pipeline Analyst Context and its stable role directory, with captured evidence supplied explicitly. Same-task repair can continue its Context when base/dependencies/cwd remain compatible; changed materialized inputs require a new binding/directory.

Acceptance applies to the exact selected result and every current criterion. A newer attempt does not silently replace it. Reviewer A can inspect snapshot A while its author produces B or another task. Selected accepted A can remain usable while B runs, provided no mandatory repair/rejection invalidates A.

A valid targeted repair withdraws acceptance of affected selections, records the issues, and marks their consumers stale. Rework creates new attempts/repair scopes; it never adds backward edges to the task DAG. Reassemble and rerun verification after any selected source/test input changes. Unknown triage or exhausted limits pauses for explicit recovery.

Run Task/Retry is allowed only within an active/paused approved map execution using captured templates and normal criteria. It cannot bypass approval or revive a superseded generation.

## Verification-cycle bound

The Map engine owns failedVerificationCycles per captured map generation, with captured config maxFailedVerificationCycles = 3 by default. One completed verification cycle is one Assemble/check pass over one selected input set: a valid conflict or one or more valid failed required checks increments the counter **once**. Successful verification does not reset it. Operational spawn/timeout/CLI/capture failure pauses through recovery and does not count as a normal negative result.

Below the limit, validated triage may request task repair or specification revision. At the limit, capture failure/triage evidence and pause the Map before dispatching another repair or verification cycle; no implementation_complete result is emitted. Retargeting a different task, retrying the utility or reopening the same specification via Delivery/priorState preserves the counter. Per-task repair limits and parent Loop active-time/iteration limits remain independent backstops.

The prior map-state record and navigator include count, captured limit, cycle ID, selected input identities and pause reason. Journal cycle start/outcome and limit reached before any dispatch decision. Pre-M5 schemas/events must serialize these fields. Raising the bound requires an explicit recorded recovery command; never reset it automatically. A new approved specification/base/template generation starts a new counter, retaining the previous one historically. [Decision fixtures](fixtures/decisions.json) cover the third failure, changed task target and operational failure.

## Lifecycle and task state

Draft/Awaiting approval are plan-preview states. Execution begins only after engine certificate validation.

| Map state | Trigger | Next state |
| --- | --- | --- |
| Draft | Submit captured bundle for documentation review | Awaiting approval |
| Awaiting approval | All mandatory decisions valid | Approved |
| Awaiting approval | Valid documentation rejection | New draft revision |
| Approved | Map starts with pinned templates/base | Running |
| Running | Operational issue, limit, user pause | Paused, retaining current facts |
| Paused | Explicit valid recovery | Running |
| Running | Valid specification issue | Revision required; return typed outcome after children stop |
| Running | Every required task accepted, no owned live processes | Implementation complete |
| Running/Paused/Approved | Selected specification replaced | Superseded after stopping owned work |
| Any active state | Explicit Stop | Canceled after descendant process exits |

| Task state | Meaning / transition |
| --- | --- |
| waiting | Required approved inputs/dependencies unavailable |
| ready | Inputs captured/current; waiting for capacity |
| running | Initial/required repair attempt active |
| awaiting_review | Complete selected snapshot awaiting criteria |
| accepted | Every criterion current for the selected snapshot |
| needs_changes | Valid review/check requests targeted repair |
| stale | Selected result invalid under changed selection/spec/template/input |
| blocked | Operational issue, unknown cause, or limit requires user action |
| canceled | Explicitly stopped/superseded work |

A still-valid accepted selection remains accepted with a separate running/review badge for unselected B. Attempt states are separate; valid negative decisions are needs_changes, not CLI failure.

Progress = accepted required tasks / total required tasks in the selected revision. Attempts do not add tasks. Acceptance withdrawal/revision can reduce the current count; previous accepted history remains. Map completion does not claim final technical or Customer acceptance.

## Navigator

M5 delivers basic graph/list navigation: dependencies, accepted/total, waiting/running/blocked counts, selected revision, and task inspection. Each task shows definitions/section links, readiness reasons, pinned inputs/templates/roles/models/Contexts, selected result and other attempts, criterion verdicts, issues, and actual check/snapshot links.

M6 adds generated historical canvases, richer selection/carry provenance, and revision comparison through [Replay](RUN_HISTORY_AND_REPLAY.md). Inspector reads never invoke a provider.

## Revisions and carry-forward

| Change | M5 policy | M6 target |
| --- | --- | --- |
| Same specification; targeted repair | Preserve independent exact-input selected results; invalidate targets/consumers | Same |
| New specification bytes/map semantics | All document approvals re-run; new task generation; no cross-revision accepted task reuse | Verify per-scope/task independence before carrying |
| Draft template edited while map paused | Captured execution remains pinned to its old immutable template; editor shows newer draft | Same |
| Explicitly apply new template/binding | New execution generation; affected selections/consumers stale | Carry only if exact semantics/input fingerprints prove eligibility |

Template revisions, role instructions, provider/model/tool profile, base/dependency hashes, referenced normative closure/check criteria, capture scopes and output schema are captured before expansion. Resume uses those revisions. A paused map does not silently read the edited latest template.

M6 task carry requires unchanged task semantics, normative closure, base/dependency inputs, template/config/environment, output integrity and criteria, plus no unresolved mandatory issue/repair. New global spec ID alone need not invalidate an independent task; the engine creates a carry record linking old evidence to the new subject. A changed/unknown dependency fails closed.

Whole-subject review is the default through M5. Cross-revision review carry rules belong to [Pipeline execution](PIPELINE_EXECUTION.md#selective-reviews-at-m6); neither this schema nor proposed prose implements them.
