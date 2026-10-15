# Second Review Resolution — v0.7

Date: 2026-10-13
Scope: documentation/schema/example corrections and reproducible offline checks.
Source: [second review](2026-10-13-second-review.md).
Status: proposed contracts; no M1 implementation authorized or performed.

The historical reviews and v0.6 response remain unchanged. These corrections refine the proposed baseline; D01–D18 retain their confirmed status. This record does not mark new defaults human-approved.

## M1 corrections

| Finding | Resolution | Normative home |
| --- | --- | --- |
| M1-1 failure cancels healthy calls | Explicit draining state stops new dispatch; running siblings finish/capture. Root Stop still cancels them. Every planned executable node has a scheduled attempt, allowing blocked transitions without launching it. | [Run/attempt transitions](../M1_CONTRACTS.md#run-and-attempt-transitions) |
| M1-2 workflow-local capacity | Removed limits from workflow schema/example. Singleton application settings and revision-checked command govern all workspaces; lowering limits does not cancel active calls. Settings changes are journaled for active runs. | [Scheduler](../M1_CONTRACTS.md#scheduler-and-resource-locks), [settings schema](../schemas/application-settings.schema.json) |
| M1-3 excessive small files/fsyncs | 64 KiB/250 ms per-stream log batches; terminal flush; bounded pending capture/backpressure. Envelopes are inline SQLite JSON with digest/byte size, and batches may share a FULL transaction. Replay uses captured boundaries. | [Log batching](../RUN_HISTORY_AND_REPLAY.md#log-batching), [storage](../STORAGE.md#database-and-commit-boundary) |
| M1-4 no discovery APIs | Paginated runs/workflows/workspaces, filters, stable creation tuple/fence and strict response/query definitions. Interrupted history is discoverable after restart. | [HTTP/SSE API](../M1_CONTRACTS.md#httpsse-api), [API schema](../schemas/runtime-api.schema.json) |
| M1-5 unscoped Contexts | Separate run_context_bindings maps run/Context node/mode to UUID native binding. Workflow derives from captured run; continued identity can be referenced by multiple runs. New origins are unique; run snapshots expose mappings. | [Context](../M1_CONTRACTS.md#context-binding-and-native-configuration), [DDL](../storage/m1.sql) |
| M1-6 hashes/processes/validation/timeouts | Two named workflow hashes; createRun explicitly pins snapshotSha256. Rust owns the Job and closes it on Node/application exit; standalone mode reports weaker containment and blocks uncertain recovery. Slot/provider IDs have semantic uniqueness checks; bracketed model aliases pass. Timeout maximum is an integer capability, with M1 semantic cap 600 and future extended-capability fixtures. | [Identity](../M1_CONTRACTS.md#workflow-and-identity), [containment](../M1_CONTRACTS.md#process-containment), [semantic validation](../M1_CONTRACTS.md#semantic-validation-beyond-json-schema) |

The Context correction intentionally uses a mapping table rather than putting one run/mode on the reusable native identity. That preserves continued sessions across historical runs while making New's run/node ownership explicit.

## Later-pipeline corrections

| Finding | Selected semantics / remaining milestone work |
| --- | --- |
| 3.1 zero-active selected join | All alternatives inactive → join Skipped/output Inactive; propagate downstream. Pending is still waiting; failed active data is recovery. [Decision table](../PIPELINE_EXECUTION.md#route-and-selected-join) and fixtures specify the happy path. M4 must serialize/test it in its engine. |
| 3.2 missing test-case inputs | Both test-author tasks now receive their functional CHECK definitions. Fingerprint roots include all spec inputs and checks whose positional args match output paths. The validator rejects removing both input and read scope. See [map validation](../IMPLEMENTATION_MAP.md#canonical-task-json-and-validation). |
| 3.3 unbounded Map repair | Map-generation counter defaults to 3 failed verification cycles; task retargeting and same-spec priorState preserve it. The third failure pauses before another repair; operational failure is separate. [Counter rules](../IMPLEMENTATION_MAP.md#verification-cycle-bound) are pre-M5 schema/event/config prerequisites. |
| 3.4 utility embeds Analyst | A utility has no own provider/session, but declares embedded Agent roles and their bindings. Verification triage uses Analyst's pipeline Context and ordinary locks/provenance. Full registry/template serialization remains pre-M4/M5 work under [registry rules](../PIPELINE_EXECUTION.md#role-views-and-registry). |

These are documented decisions and reusable expectations, not completed M4/M5 runtime features.

## Reproducible validation

P1 is addressed by [tools and instructions](../tools/README.md), [fixture manifest](../fixtures/manifest.json), [negative variants](../fixtures/invalid/cases.json), [decision cases](../fixtures/decisions.json) and [SQL cases](../fixtures/sql-cases.json). package.json exposes npm run docs:check. The command uses local Python >= 3.11, pinned jsonschema 4.26.0, and in-memory SQLite; it invokes no provider and writes no application store.

Validation result: `npm.cmd run docs:check` passed with no errors on 2026-10-13:

- 10 schemas, with local references resolved offline.
- 57 positive schema cases, 25 structural rejections and 14 semantic rejections.
- 21 decision cases, 24 SQL cases across 13 tables and 2 strict-JSON rejections.
- 230 local links, 23 Markdown files, 2 typed JSON examples, 14 indexed sections and 5 map tasks.

The setup pins jsonschema with format-check dependencies. Startup verifies UUID/date-time checks are present; a malformed timestamp fixture prevents a bare installation from silently skipping that validation.

The old v0.6 one-off totals remain historical claims; this package supplies fresh reproducible replacement checks. Documentation validation establishes schema/semantic/example consistency, not actual CLI cancellation, runtime fsync behavior or Windows containment. Runtime exit evidence is still required by [MILESTONES.md](../MILESTONES.md).

## Authorization and implementation boundary

P2 remains unchanged: only an explicit user request to implement the selected milestone authorizes that work. The runtime, frontend, Rust prototype and package lock remain unchanged; package.json gains only the documentation-check command. There is no Git metadata in the current workspace, so scripts/fixtures are saved locally rather than represented as a commit.
