# Pipeline Execution Contracts

Version: 0.7  
Status: proposed M4–M6 semantic contracts; schema prerequisites explicit  
Updated: 2026-10-13

This document owns specification bundles, role review material, Gate/Route, task capture/assembly, actual checks, and triage. Generic scheduling, Loop mechanics, journal and storage each have [their own home](README.md#rule-ownership-and-precedence).

## Primitive boundary catalogue

These target ports extend core-v1 only at their milestone; they are not accepted by the M1 workflow schema.

| Primitive | Inputs | Outputs/configuration |
| --- | --- | --- |
| Agent extension (M2+) | prompt Text; optional files ArtifactSet | Captured files plus Text/validated JSON; declared capture paths and output schema |
| Gate — prepare (M4) | subject ArtifactSet; issues JsonValue; base ArtifactSet for specification or optional priorApproval JsonValue for final Customer | Immutable validated subject, named role-view ArtifactSets, reviewPlan JsonValue; configured roles/scope selectors |
| Gate — evaluate (M4) | subject ArtifactSet; named required review JsonValues | report JsonValue, certificate JsonValue (null if closed); verified issue ledger |
| Gate — verify (M4) | subject/reference and optional stored certificate | OPEN or REVISION_REQUIRED report after exact-subject/policy verification; no model call |
| Route (M4) | selector JsonValue; value of configured type | One named active value output; pointer/case literals and onUnmatched error or pause |
| Merge — selected (M4) | Alternative inputs of one configured type | value for exactly one successful active input; Inactive when every alternative is inactive |
| Implementation Map (M5) | Approved documentation, certificate, base, optional prior state/repair | result ArtifactSet; outcome summary JsonValue; pinned registry/templates |
| Assemble (M5) | base ArtifactSet; selected TaskResult ArtifactSets | candidate ArtifactSet or conflict evidence, report JsonValue |
| Test Runner (M5) | candidate/task-result ArtifactSet | Engine report JsonValue + evidence ArtifactSet; pinned executable/args/env/timeout/expected exit/parser |

JSON Select and record Merge provide explicit conversions/mapping under [Loops](LOOPS.md#decision-and-record-construction). Container Input/Return boundaries are not palette nodes.

## Specification bundle and section index

A specification is an immutable ArtifactSet containing source documentation, canonical map JSON, typed section index and referenced contract files. A capture manifest records paths/exact hashes, engine subject ID and selected project-base reference. No floating “latest spec” pointer enters a task.

Use [spec-section-index.schema.json](schemas/spec-section-index.schema.json) and [the example](examples/round-recovery/spec-index.json). Parsing rules:

- Index `document` names a normalized relative Markdown file in the bundle.
- Every indexed section appears exactly once as an exact second-level heading `## ID` outside fences. Its body ends at the next second-level heading; title/preface are informative metadata.
- Every ID heading must be indexed. IDs are unique across the bundle; dependencies resolve and form a DAG.
- Index `kind` classifies business, requirement, contract, check, acceptance, map, or informative. REQ-/CONTRACT-/CHECK- prefixes are mandatory for those three kinds.
- `normative` and `visibility` explicitly classify each section. Informative entries cannot become requirements or fingerprint dependencies.
- `dependsOn` is the only machine-readable dependency grammar; prose links do not create hidden normative edges.
- Check entries include executable settings and source selection. Map entries include the linked canonical map bytes in their fingerprint.

Engine-generated section hashes combine exact section bytes, canonical index metadata, declared transitive dependencies, and referenced normative artifact bytes. Unknown coverage/dependencies disallow selective carry. Whole-bundle and role-view hashes are also retained.

## Role views and registry

Documentation/Analyst/Customer roles use a stable per-role run directory with captured revision inputs kept in named subdirectories, so their native Context can continue across revisions without changing cwd. Snapshot-review and task roles use subject/task-specific copies; changing those materialized bindings requires a fresh Context. Only the current prepared view is supplied as the current invocation's input.

Role registry entries pin kind, instructions, provider/model where applicable, scope selector, template revision, Context policy and tool/native profile. Utility entries have no **own** provider/model/native session, but may embed invocations of named Agent roles. Their captured template declares embeddedRoles and resolves each invocation through that role's explicit model/instructions/Context/resource bindings. The reference verification utility embeds Analyst triage using the Analyst's pipeline Context, not an invented verification session. All embedded invocations obey the same ordering/locks/capacity and journal their actual Agent role. Preflight validates both utility outputs and embedded roles, including ordering against outer calls sharing a binding. Missing capabilities/bindings fail preflight.

Documentation Customer selector = normative `visibility: public` entries of kind business/requirement/acceptance. Materialize only those sections plus source identity/manifest. In round recovery this includes BUSINESS-TASK, public REQ-* and ACCEPTANCE-SCENARIOS. Internal contracts/check definitions/map/source are excluded. Claude readiness and Antigravity testability receive the complete normative bundle/map.

Each view has engine-owned source bundle ID, selected sections/hashes, and materialization identity. Every decision anchors to the same specification ID while its expected scope/view hash is role-specific. A whole-subject policy re-runs every required role for a new revision, even when one public view's bytes stayed the same.

Final Customer gets original business/public API/scenarios, observed public responses and engine check summaries linked to the candidate; quality/conformance reviewers get source and exact check evidence. The final view is created only after technical approval. No Analyst private history is forwarded.

These rules govern supplied material. Same-account native memory/settings/tools can extend what an Agent sees under Full Access; [the Context/trust limits](M1_CONTRACTS.md#context-binding-and-native-configuration) still apply.

## Review and Gate

Agent ReviewDecision carries schemaVersion, subjectId, role, verdict APPROVED/CHANGES_REQUESTED, scopeRefs, resolvedIssueIds, and issues. An issue contains localId, severity blocker/suggestion, ownerRole, requirementRefs, message, requestedChange. The exact strict schema/policy/certificate formats are required before M4 coding.

Gate policy defines named review slots, each binding an expected logical role/purpose and scope selector. Port aliases such as readiness/quality name slots, not a different provider role. Prepare's named views and evaluate's decision inputs use those same slot IDs.

CHANGES_REQUESTED requires at least one blocker/requested change; APPROVED can include suggestions but no blocker. The engine verifies the captured invocation role/model/subject/view, validates the JSON, stores raw decision evidence, assigns global issue IDs, and writes a trusted review record. An Agent-supplied role/ID is not proof by itself. Issues are returned to the correct owner; only a current validating review from the responsible reviewing scope can resolve its old blockers. Analyst prose cannot close them.

| Gate state | Trigger | Behavior |
| --- | --- | --- |
| PENDING | Required decision unavailable/in flight | Wait; no report/certificate data output |
| OPEN | All required approvals current and no unresolved mandatory blockers | Emit report + engine certificate |
| REVISION_REQUIRED | Complete required judgments include a blocker/rejection | Emit report with identified issues and null certificate |
| Blocked inspection state | Operational review error/corruption | Pause/fail recovery; never turn error into a valid rejection |
| Superseded/stale | Subject/policy changed | Old certificate stays historical and cannot authorize current work |

Report includes status, subjectId, reason, issues and nullable certificate reference. The certificate output and report field are typed record references (recordId + artifact digest), with full certificate facts stored in that immutable record. OPEN certificate pins subject, policy, expected role scopes, decision IDs and evidence hashes. Map and later Gates verify that record and current inputs, not an Agent's claimed APPROVED text.

M4/M5 use whole-subject re-review. Only an exact unchanged already-approved subject with valid stored certificate may bypass authoring/reviews; [the outer Route](TEST_PIPELINE.md#delivery-loop-wiring) makes this visible. All required reviewers run after any new revision.

Final technical approvals pin the same specification, candidate, passing required reports and environment. Final Customer approval pins that subject plus technical certificate. Candidate/input/report changes invalidate all dependent final certificates.

## Selective reviews at M6

Gate prepare exposes a named engine reviewPlan entry per required role: status missing/stale/current/carried, Boolean needsReview, expected subject/view/scope hash, and optional verified prior decision reference.

For each role, use an explicit Route on needsReview:

- true → live reviewer Agent using its prepared view;
- false → stored verified decision JsonValue;
- selected-alternative Merge joins these mutually exclusive values → Gate evaluate's named role input.

All required joins resolve before evaluation. A fixed DAG targeting every live Agent cannot claim selective skipping.

A carry certificate links the old/new subjects, prior approval, unchanged view/closure/instructions/config/base fingerprints, and engine validation. Missing/stale/incomplete coverage forces a live review. A rejection/blocker is never turned into carried approval. Issue ownership/resolution remains valid across revisions. Template or tool/native profile edits invalidate the affected review plan.

This target mechanism is specified here but its reviewPlan/carry schemas and fixtures are pre-M6 work.

## Route and selected join

Route has explicit selector pointer and literal cases. Exactly one case may match; multiple matches are a contract error. Unmatched defaults to error. The reference triage Route explicitly pauses for unknown/unmatched cause, preserving the decision/evidence for user action.

Inactive alternatives are recorded as Skipped and propagate inactivity through their dependent branch. This differs from failed/unavailable required input. Selected Merge follows this complete table; a merely unfinished alternative cannot be guessed away.

| Resolved alternatives | Outcome |
| --- | --- |
| Exactly one succeeded; every other alternative proven inactive | Commit its value |
| Every alternative proven inactive | Mark the join Skipped; output Inactive; propagate downstream inactivity |
| An alternative is still unresolved and no contract error is known | Wait |
| More than one active alternative | Contract error |
| Required active alternative failed/unavailable | Operational recovery; never reinterpret it as inactive |

This rule lets the Delivery failure join and TASK-VERIFY evidence join disappear on a successful path, while the accepted Return still resolves. [Decision fixtures](fixtures/decisions.json) pin the all-inactive and pending cases for the future M4 runtime tests.

No Route/selected join creates a backward edge. Loop Return carries rework into the next captured iteration.

## Task capture and assembly

Provision copied work directories under [the sibling layout](STORAGE.md#layout-and-ownership). Materialize only captured base + pinned dependency results + selected task material. Validate capture paths and directory identity before dispatch. Reviewers/checkers receive separate copies of immutable results.

A TaskResult is created only after executor termination, output-contract and file validation. It records task/attempt/spec/template/input identities, declared outputs, feedback/issues, and file operations:

- create: new path with content hash;
- replace: path, captured preimage hash and new content hash;
- delete: path and captured preimage hash.

A live directory is not a review identity. Review A continues against A while its executor produces B elsewhere/in its leased directory. Unexpected writes, missing declared files, path escape or preimage mismatch cannot become an accepted result.

Assemble consumes selected captured TaskResults over one base. Apply operations deterministically; disjoint valid changes combine. Overlapping operations with different content, incompatible preimages, edit/delete collision, case/path ambiguity or missing inputs produce an engine conflict report. No last-writer-wins. Exactly identical compatible operations can deduplicate with both provenance links.

Derived Candidate records base/result IDs, path hashes, aggregate manifest hash and assembly configuration. Output `type: candidate` in the map denotes this engine record, not a role-name-based write-scope exception. TaskResult/Candidate/Conflict schemas remain required before M5 implementation.

## Actual Test Runner

Test Runner launches the pinned executable directly with argument array (no shell interpolation), selected environment, timeout, cwd and expected exit. Check definitions are captured from the approved index/configuration; actual executable/version and parser settings join the environment fingerprint.

Run each suite on a disposable copy of the same immutable selected candidate. Task syntax checks instead use that exact test TaskResult. Hash source inputs before/after; unexpected source modification marks evidence invalid. Allowed report/temp output paths are explicit and separate.

A report records check/spec/candidate-or-result IDs, executable/config/environment, timestamps, actual exit/signal, stdout/stderr/evidence hashes and source-integrity result. Passing means completed valid process evidence, intact sources and required exit. Valid exit mismatch is a successful reporting attempt with a failed check criterion.

Spawn failure, timeout/interruption, missing logs or integrity mismatch is operational failure. It never yields passing evidence. An Agent saying “tests passed” is source text, not a Test Runner record.

For the example, static code review and test review + syntax checks accept the four source tasks. Combined functional checks accept TASK-VERIFY. This avoids making source acceptance depend on its own downstream verification. Syntax passing alone proves only parseability.

## Triage and invalidation

Triage decision fields: schemaVersion, cause, subjectId, affectedTaskIds, requirementRefs, reason, **issues** with identified requested changes. Cause is implementation/tests/specification/integration_conflict/unknown. No extras or silently missing fields; strict schema is required before M5.

Implementation/tests/integration_conflict requires nonempty valid task targets consistent with the captured evidence/approved scope. Specification requires nonempty normative refs/issues and returns to Analyst. Unknown pauses for explicit user correction; no automatic guess/repair.

Task templates return:

- candidate: captured output eligible for exact criteria;
- repair_requested: validated targeted repair + failure evidence; Map retracts target acceptance and invalidates consumers;
- specification_revision_required: unresolved normative issue + captured evidence; Map returns to Delivery Loop without authoring against a draft.

TASK-VERIFY's Assemble/check template handles conflicts or failed integration checks with Analyst triage **inside Map**. Repair restarts affected task scopes and verification; no duplicate outer integration run is needed. Outside Map, final technical/Customer rejection also uses triage; specification cause reopens docs, task cause creates same-spec repair for the next Delivery iteration.

M5 preserves independent exact-input task selections only within the same specification. New documentation causes fresh approval/task generations. M6 verified cross-revision selection carry is defined in [Implementation Map](IMPLEMENTATION_MAP.md#revisions-and-carry-forward).

## Persistence and implementation boundary

All judgments, certificates, selected snapshots, issue updates, candidates/conflicts, actual reports, Route decisions and invalidations are immutable engine records/events governed by [storage](STORAGE.md) and [history](RUN_HISTORY_AND_REPLAY.md#m4m6-generated-history).

Scoped Map/Task/Loop commands, nested resource events, role/template serialization, Gate policies and check/triage/certificate schemas must be supplied before their milestones. M1's API/schema does not already support these actions. [MILESTONES.md](MILESTONES.md#contracts-required-before-each-milestone) is the readiness checklist.

The reference pipeline produces inspectable accepted delivery artifacts; promotion/deployment and automatic Git operations are outside scope.
