# Decision Register

Version: 0.13
Status: confirmed requirements, accepted ADR-0001 through ADR-0005, and milestone baseline
Updated: 2026-10-16

This is the sole register of requirement/proposal acceptance. The current request authorizes implementation of ADR-0003, ADR-0004, and ADR-0005 through Stage 3. No proposed default is silently marked human-confirmed.

## Confirmed decisions


| ID | Decision | Basis |
| --- | --- | --- |
| D01 | The product is personal and runs as a desktop application. | Personal-use clarification and selected stack. |
| D02 | Use Tauri, React, and React Flow. | Explicit stack choice. |
| D03 | Use an Orange-inspired canvas with a node palette. | Explicit interface direction. |
| D04 | Agent providers and utility operations appear as nodes. | Explicit node concept. |
| D05 | Prompts arrive as connected input data; a Text node can supply a literal prompt. | Prompt-input discussion. |
| D06 | A separate Context node owns a reusable provider conversation. Multiple compatible Agent nodes can use it. | Codex -> Claude -> Codex context-continuation scenario. |
| D07 | Support starting a new session and continuing an existing session. | Explicit session requirement. |
| D08 | Initial CLI integrations are Codex, Claude Code, and Antigravity. | Requested checks and completed hello-world prototype. |
| D09 | Documentation and authored free-form text use English. | Explicit language requirement. |
| D10 | The current phase produces documentation and proposed design decisions without implementing new product behavior. | Current instruction. |
| D11 | Communicate with the user in Russian while keeping documentation in English. | Explicit chat-language clarification. |
| D12 | Save a log of every workflow run, rather than only its final result. | Explicit per-run logging requirement. |
| D13 | Include loops in the first version; normal completion is condition-based and an Agent may decide whether to continue. | Explicit loop-scope and agent-checking correction. |
| D14 | Record the proposed software-development pipeline as a test/reference scenario and document the mechanisms for its complete implementation. | Current documentation request and supplied scenario. |
| D15 | An Implementation Map node describes task decomposition, dependencies, and potential parallel work; its JSON is part of implementation documentation. | Explicit replacement of commit-centered planning with the documented task map. |
| D16 | The map has inputs/outputs and opens as a progress navigator showing completed and unfinished work. | Explicit map-interface clarification. |
| D17 | The map covers implementation tasks; Analyst revisions and documentation approval belong to the surrounding pipeline, and the draft map evolves with documentation. | Explicit stage-boundary clarification. |
| D18 | Claude documentation readiness and implementation are separate roles; Antigravity documentation testability and test authoring are separate roles. | Explicit role-separation clarification. |
| D19 | Specify external workflow authoring through the API of an already running Deszo application, covering Codex, Claude Code, and Antigravity from the first integration release, with direct API use by other applications. | The 2026-10-15 request for an English ADR covering the discussed integration and all three clients; documentation is authorized, implementation is not. |
| D20 | Preserve the maximum available execution information for complete post-run analysis, with explicit capture gaps and provider availability limits. | The 2026-10-16 request to plan further Deszo improvements and create an ADR. |
| D21 | The user will launch the shadcn/ui implementation through the external assistant, which must observe/control the run and stop all work belonging to it when a Deszo bug is detected. | Explicit 2026-10-16 supervision and Stop requirement. |
| D22 | Record a detected Deszo bug in Deszo with execution evidence. Prepare the design/ADR now; implementation and pilot execution remain pending. | Explicit 2026-10-16 reporting requirement and documentation-only instruction. |
| D23 | Specify a general effective development workflow, including how task assessment affects its stages and how effectiveness will be tested across different task classes. | The 2026-10-16 discussion explicitly broadened the scope beyond shadcn/ui and requested a new ADR; detailed mechanisms remain proposed. |
| D24 | Specify agent communication and context-management contracts, covering structured results, controlled technical prose, relevant inputs and measured efficiency while preserving available audit. | The 2026-10-16 supplied communication proposal, discussion and request for a second new ADR; detailed mechanisms and savings remain unaccepted hypotheses. |
| D25 | Specify verified local feature-branch delivery as a separate ADR/reference stage, preserving exact candidate identity through source assertion, apply, environment verification and commit. | The 2026-10-16 agreement to the six review refinements and a separate ADR-0005; implementation and Git execution are not requested. |

## Inherited requirements

These are carried forward from the original architecture draft. Changing them requires an explicit decision.

| ID | Requirement |
| --- | --- |
| R01 | Select providers and models explicitly; never substitute them automatically because of cost or remaining quota. |
| R02 | Use official CLI account authentication and subscription access for the subscription-backed agents. |
| R03 | Do not silently enable API billing, paid credits, or another paid fallback. |
| R04 | The orchestrator manages execution state, transitions, inputs, outputs, artifacts, and provider-session mappings. |
| R05 | Transfer selected inputs and artifacts rather than forwarding every agent's accumulated conversation to every other agent. |
| R06 | Keep workflow execution independent of React Flow's presentation state. |
| R07 | Preserve inspectable run history, events, resolved inputs, and output provenance. |
| R08 | Any fallback branch or provider reassignment is explicitly defined or manually selected. |
| R09 | If loops are introduced, bound their iteration count and/or duration. |


## Proposed resolutions

P01–P22 remain **Proposed** and answer the corresponding Q IDs. P23–P27 are listed under accepted proposals below. Detailed behavior lives at the linked home; [MILESTONES.md](MILESTONES.md#m1-baseline-for-an-implementation-request) identifies the concrete M1 baseline.

| ID | Proposed selection | Rule home |
| --- | --- | --- |
| P01 | Staged M1–M6; first user release after M2; basic map navigator at M5. | [Contract](MILESTONES.md) |
| P02 | One workspace project/scratch binding; distinct copied task directories. | [Contract](M1_CONTRACTS.md#workflow-and-identity) |
| P03 | Strict core-v1 workflow schema; explicit later capability extensions. | [Contract](M1_CONTRACTS.md#workflow-and-identity) |
| P04 | Typed Text/JSON values and explicit later artifact conversion; engine-owned provenance. | [Contract](M1_CONTRACTS.md#core-node-and-port-catalogue) |
| P05 | Literal Text/named Prompt Template slots; visible output-contract/native instruction sources. | [Contract](M1_CONTRACTS.md#core-node-and-port-catalogue) |
| P06 | Optional Context; New per run or exact Continue binding; no silent fresh fallback. | [Contract](M1_CONTRACTS.md#context-binding-and-native-configuration) |
| P07 | Application-wide provider/global capacity, native/cwd locks and atomic acquisition. | [Contract](M1_CONTRACTS.md#scheduler-and-resource-locks) |
| P08 | Explicit model/capabilities; Restricted native settings default, visible opt-in Inherit. | [Contract](M1_CONTRACTS.md#context-binding-and-native-configuration) |
| P09 | M3 selected reruns and stale-input validation; never rewind native history. | [Contract](M1_CONTRACTS.md#later-reruns-and-context-chat) |
| P10 | Supervised Node process-per-attempt and authenticated loopback HTTP/SSE. | [Contract](M1_CONTRACTS.md#httpsse-api) |
| P11 | Failure drains healthy running siblings; explicit Stop and interrupted recovery; manual operational retry; negative verdicts are data. | [Contract](M1_CONTRACTS.md#run-and-attempt-transitions) |
| P12 | M3 standalone Live/Frozen/Refresh checkpoint, no TTL/prompt memoization. | [Contract](LOOPS.md#cache-inside-a-loop) |
| P13 | Frozen replays data with prerequisite checks, not native turns or filesystem effects. | [Contract](M1_CONTRACTS.md#later-reruns-and-context-chat) |
| P14 | Full Access with sibling workdirs; scope declarations do not isolate agents. | [Contract](STORAGE.md#layout-and-ownership) |
| P15 | SQLite inline hash-verified event envelopes, batched immutable log objects and complete journals. | [Contract](STORAGE.md) |
| P16 | Docked inspectors/Context chat and basic map progress navigator. | [Contract](PRODUCT_SPEC.md) |
| P17 | JSON record Merge, post-check loops; M4 Gate/Route/selected join/nesting. | [Contract](LOOPS.md) |
| P18 | M2 read-only Replay; M6 generated-history navigation, recording begins earlier. | [Contract](RUN_HISTORY_AND_REPLAY.md) |
| P19 | Documentation-owned task map; engine facts; accepted/total navigator projection. | [Contract](IMPLEMENTATION_MAP.md) |
| P20 | Distinct roles, exact-subject approvals; cross-revision carry at M6. | [Contract](PIPELINE_EXECUTION.md#review-and-gate) |
| P21 | Immutable TaskResults, copied directories, conflict-checked assembly and real checks. | [Contract](PIPELINE_EXECUTION.md#task-capture-and-assembly) |
| P22 | Same-spec task repair and bounded Map verification cycles at M5; selective cross-revision carry at M6. | [Contract](IMPLEMENTATION_MAP.md#revisions-and-carry-forward) |

## Accepted proposals

| ID | Accepted selection | Acceptance record | Rule home |
| --- | --- | --- | --- |
| P23 | One runtime-owned HTTP authoring contract and one stdio MCP bridge shared by Codex, Claude Code, and Antigravity, with guarded saves, durable changes, editor synchronization, and an explicit API migration. | Accepted 2026-10-15 after the sixth review reported no open findings. | [ADR-0001](adr/0001-external-workflow-authoring-api-and-mcp.md) |
| P24 | Lossless qualified audit, bounded external supervision with a run-specific grant/watchdog, verified per-run Stop, local incidents and offline audit bundles. | Accepted 2026-10-16 after the second review reported no architecture findings; Stage 1/2 contract items remain required. | [ADR-0002](adr/0002-execution-audit-and-supervised-control.md) |
| P25 | A reference development workflow with evidence-based task assessment, versioned planning rules, explicit role bindings and aggregate limits, evaluated against a diverse corpus with independent outcome checks. | Accepted 2026-10-16 after the second review; Stages 1–3 implemented. | [ADR-0003](adr/0003-task-assessment-and-workflow-planning.md) |
| P26 | Structured control results, concise technical prose, role-specific immutable context packages, bounded additional reads and measured communication efficiency without reducing available audit. | Accepted 2026-10-16 after the second review; Stages 1–3 implemented. | [ADR-0004](adr/0004-agent-communication-and-context-contracts.md) |
| P27 | Optional runtime-managed delivery from an accepted candidate to an exact verified local feature-branch commit, with source/ref preconditions, environment evidence, recoverable Git operations and commit-specific readiness. | Accepted 2026-10-16 after the second review; Stages 1–3 implemented. | [ADR-0005](adr/0005-verified-feature-branch-delivery.md) |

## Open decisions and implementation authorization

Q01–Q22 have selected proposals, so they no longer need a second copied answer table. Their traceable topic links remain in [PROPOSED_BASELINE.md](PROPOSED_BASELINE.md). Pending work is the milestone-specific **contract package**, not an unanswered product-choice list.

Before implementation, record the scope the user has authorized and any corrections to this baseline. An explicit request to implement M1 under the documented baseline is sufficient; do not require additional individual approvals for P01/P03/P04/P07/P10/P11/P15 after that authorization. Silence alone is not acceptance.

The 2026-10-15 external authoring request authorized ADR-0001 and its navigation/register updates. D19 is the requested integration scope. P23 and ADR-0001 were accepted on 2026-10-15 after the sixth review reported no open findings. This design acceptance does not authorize implementation, client configuration changes, or live provider tests; those require a separate instruction.

D20–D22 record the user's audit, supervision and local bug-reporting requirements. P24 and ADR-0002 were accepted on 2026-10-16 after the second review reported no architecture findings. Acceptance authorizes the design only: implementation, new control permissions, client configuration changes, live provider calls and shadcn/ui pilot execution each require a separate instruction. ADR2-07 through ADR2-10 remain required Stage 1/2 contract and verification items.

D23–D25 record the general development workflow, agent communication/context contracts, and verified feature branch delivery requirements. Following the resolution of second-review findings, the user explicitly instructed implementing ADR 3, 4, and 5 on 2026-10-16. P25, P26, and P27 are Accepted. Stages 1–3 are implemented locally with deterministic test fixtures and offline schema validation. Stage 4 evaluation with real providers and quota consumption remains gated under its documented planning estimate (~630–2,500 invocations).

The subsequent request to finish the task authorizes the pending domain-to-engine integration and its local verification. The executable bounded [managed-task compiler](MANAGED_TASKS.md) now uses captured node templates, ordinary attempts and the existing authoring/authorization boundary. It does not claim automatic parallel Map decomposition, real-model efficiency results or completion of the separate client supervision acceptance matrix.

## Superseded assumptions

Context owns native history; edges transfer selected data. Resume appends to the current native end. Cache and Replay restore no native turns or filesystem side effects. Snapshots replace required commit identity.

The v0.5 all-at-once implementation scope is superseded by M1–M6. D13 still requires loops in the first user release. Nested loops/Gates/Map/checks are required by the full scenario but arrive at their milestones. Whole-subject re-review is the M4/M5 default; verified cross-revision carry arrives at M6.

Native configuration inheritance is a visible opt-in target behavior. The current prototype's suppression remains the M1 Restricted default, rather than silently enabling extensions or native configuration.
