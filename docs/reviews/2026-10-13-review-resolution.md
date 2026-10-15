# Documentation Review Resolution

Date: 2026-10-13  
Baseline: documentation v0.6  
Scope: documentation/schema/example corrections only

[The original review](2026-10-13-pre-implementation-review.md) is preserved unchanged. “Specified” below means a documentation contract exists. It never means the prototype implements or has passed that contract.

## Blocking findings

| Finding | Resolution and evidence | Remaining boundary |
| --- | --- | --- |
| B1 — oversized first scope | [M1–M6](../MILESTONES.md) has working exit criteria. First user release is M2 with loops; M5 already has a basic navigator. | Full pipeline remains a staged target. |
| B2 — missing contracts | M1 now has [workflow/catalogue/API/states](../M1_CONTRACTS.md), values/attempt/journal/API schemas, [storage/DDL](../STORAGE.md), and a saved Context-chain example. | M2–M6 missing schemas are enumerated as prerequisites before each milestone. No claim that all sixteen types have a full serialized contract. |
| B3 — structured loop carry/conversion | [Typed state](../schemas/pipeline-state.schema.json) carries base/spec/approval/issues/repair. [Loops](../LOOPS.md) defines record Merge, Select and Condition. [Specification/Delivery wiring](../TEST_PIPELINE.md#specification-loop-wiring) connects exact ports. | M2/M4 full workflow serialization and execution fixtures still required. Text feedback is intentional; structured issues stay in carry. |
| B4 — selective review skipping | M4/M5 review every role after a new revision. [M6 prepare/Route/join design](../PIPELINE_EXECUTION.md#selective-reviews-at-m6) exposes engine needsReview status. | Selective cross-revision carry is deferred to M6, not implied by a static live-review DAG. |
| B5 — limits and queue time | [Active clock](../LOOPS.md#limits-and-active-clock) uses wall-clock union, excludes capacity/lock/user waits, and records queue telemetry. Spec/delivery/task backstops are 120/360/90 minutes. | These are initial proposals, not measured timing guarantees; count/time limits are independent. |
| B6 — example ownership/dependency/failure | Separate REQ-OWNERSHIP; resume refs include auth/ownership/contracts; ownership tests moved to recovery. Boundary failure now expects 401 but observes 200 for expiresAt === now. | Future toy-project preparation and actual checks remain unperformed. |
| B7 — reachable evidence store | [Sibling workdirs/store](../STORAGE.md#layout-and-ownership); immutable digest/size verification on every read; corruption blocks trust. | Full Access can still alter same-user files/database. No strong OS isolation is claimed. |

## Significant findings

| Finding | Resolution |
| --- | --- |
| S1 — section grammar | [Typed index](../schemas/spec-section-index.schema.json), exact heading grammar, normative/visibility/kind/dependency fields, check commands, explicit closure rules. Informative revision 3 is excluded. |
| S2 — engine candidate output | Map schema has explicit `type: candidate`. Only an engine-producing utility template can fulfill it; no role-name exemption. Registry must include agent and utility kinds before M5. |
| S3 — accepting broken tests | Both test tasks require review plus `node --check` criteria. Functional acceptance remains the separate combined verification; syntax success is not called functional proof. |
| S4 — Customer isolation | Supplied-view rules explicitly do not isolate shared provider memory/instructions/account state under Full Access. |
| S5 — Codex throughput | [Scheduler](../M1_CONTRACTS.md#scheduler-and-resource-locks) states Codex is the default bottleneck. Provider limit is editable, with measurement required before treating higher concurrency as reliable. |
| S6 — approved-spec bypass | [Delivery wiring](../TEST_PIPELINE.md#delivery-loop-wiring) places Gate verify + Route before nested Specification Loop. |
| S7 — Customer review scope | Gate prepare materializes public business/requirement/acceptance sections with a manifest anchored to the same spec ID; internal contracts/map/check settings/source stay out of the supplied view. |
| S8 — paused template edits | [Map revision policy](../IMPLEMENTATION_MAP.md#revisions-and-carry-forward) pins templates at expansion. Draft edits do not mutate paused runs; explicit adoption creates another generation and invalidates affected selections. |

## Structure and status

| Finding | Resolution |
| --- | --- |
| D1 — drift through repetition | [Index ownership/precedence](../README.md#rule-ownership-and-precedence) assigns one normative home. Product/architecture are UX/components. Baseline is a link index; Open Questions redirects to Decisions. |
| D2 — missing transitions | M1 run/attempt/Context transitions, Gate transitions and Map/task transitions now have explicit tables/events. Future event payload extensions are milestone prerequisites. |
| D3 — unclear approval | Confirmed D01–D18 retained. P01–P22 stay Proposed. [M1 baseline](../MILESTONES.md#m1-baseline-for-an-implementation-request) is concrete for review; a later explicit implementation request can authorize it without repetitive individual-ID approval. |

Smaller notes: root README links to the documentation index; spec:CHECK inputs are explicitly allowed; unused result_available dependency is deferred/removed from M5 schema; run transitions have a durable event type; native configuration inheritance is a visible opt-in with Restricted default.

## Validation

Validation checks structural/semantic **documentation consistency**, not runtime execution. On 2026-10-13:

- Nine Draft 2020-12 schemas passed schema validation. Thirty-nine positive payload/example cases and fifteen schema rejection cases passed.
- Four semantic rejection cases covered a cycle, unordered shared Context, missing JSON-to-Text conversion and incompatible provider Context.
- All 174 local links/anchors across nineteen Markdown files resolved; both fenced JSON examples parsed and validated. Four Mermaid diagrams are supplied; rendering and runtime compilation were not tested.
- The saved M1 DAG has nine nodes/six edges; seven nodes are executable and two are Context declarations.
- The round-recovery bundle has fourteen typed sections and five tasks. Required normative closures, check/role references, accepted dependencies, public Customer view and output paths were consistent.
- Reference SQL executed in an in-memory SQLite database: eleven tables, foreign keys, one active run per workspace, valid run states and unique journal sequence. Four rejection cases passed. This does not test durable WAL behavior on a filesystem.
- SHA-256 matched all twenty-six recorded prototype source/configuration files. The historical review content matched the original loaded text; its recorded SHA-256 is e1511dc2588d4bf60beaa55d9ef5b4a3c91b008f3fa9d9004e7350cf1cf1b4a4.

No provider call, toy-service implementation, or orchestration run is performed in this update. Real adapter behavior, cancellation, concurrency, and end-to-end pipeline acceptance remain milestone exit work.
