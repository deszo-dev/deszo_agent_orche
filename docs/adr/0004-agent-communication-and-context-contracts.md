# ADR-0004: Agent Communication and Context Contracts

- Date: 2026-10-16
- Status: Accepted
- Requirements: D24 in the [decision register](../DECISIONS.md#confirmed-decisions)
- Implementation: JSON result envelopes, role packages, native turn retrieval/resume and engine evidence acceptance are wired; see [current status](0004-implementation-status.md). Controlled prose and real-provider comparisons remain separate experiments.
- Scope: Structured agent results, controlled technical prose, role-specific context and measured communication efficiency
- Related: [ADR-0003](0003-task-assessment-and-workflow-planning.md) owns stage selection and workflow evaluation; [ADR-0002](0002-execution-audit-and-supervised-control.md) owns complete available audit

## Context

The user supplied proposals for controlled technical English, JSON-only control results, references instead of repeated content, feedback focused on changes and narrower review inputs. These are candidates for improving the general workflow, independently of any particular implementation task.

Shorter text can remove repetition, but it can also remove a condition or hide a dependency. Structured output makes transitions machine-readable; it does not prove a decision is true or guarantee fewer tokens. A smaller context package can reduce repeated reads while making a review unsound if it omits a necessary contract.

Some foundations already exist. [ReviewDecision](../schemas/review-decision.schema.json) is structured, and the [output adapter](../../runtime/core/adapters.mjs) already requests one JSON value for JSON output contracts. The [Gate implementation](../../runtime/core/gate.mjs) provides full and public views; the [Agent invocation path](../../runtime/core/engine.mjs) materializes attached files and appends their paths to the prompt. A full attachment package is not proof that every file's contents entered the model context. Available CLI events and usage determine what can actually be observed.

This ADR extends these foundations. It does not claim JSON-only output is new, replace the existing two review verdicts, or treat the proposed context features as currently supported workflow fields.

## Proposed decision

Define three communication modes and a versioned context-package contract. Keep machine transitions structured, make necessary prose precise, preserve project language, and evaluate efficiency without weakening verification or audit.

| Mode | Content | Contract |
| --- | --- | --- |
| Control results | Review decisions, task returns, issue routing, triage and references to checks/candidates | One final structured value validated against the applicable schema and runtime provenance. Engine-owned facts remain engine-owned. |
| Agent prose | Prompts, requirement narrative, short rationale and implementation notes | Controlled technical English with explicit conditions and exact project terminology. |
| Project content | UI text, documentation, source comments and domain content | The project's language/style rules. Deszo-authored content remains English under D09/D11; user/provider source content is preserved as received. |

The final result of a control step is JSON-only. Tool activity, available progress/reasoning and raw stdout/stderr continue through the audit path. Code and documents remain captured files referenced by structured results; this decision does not require encoding every file inside JSON.

## 1. Structured results and provenance

Use one authoritative structured result per control step. Avoid a second free-form summary that repeats the same verdict, issue list or check outcomes. The UI can render a human-readable view from the structured fields and artifact references. Add separate narrative only when it carries necessary reasoning not represented elsewhere.

Keep stable IDs and descriptive schema field names. Preserve contract version, exact subject/candidate identity, assigned role, scope, verdict, issue IDs, ownership and requirement references where applicable. Removing these fields to shorten a payload is not an allowed optimization.

Separate runtime-generated facts from agent-authored claims. The runtime creates provenance, check execution records, content hashes and certificates after validation. An agent can reference these records; it cannot create evidence of a passing check merely by returning valid JSON.

Validate structure, references and applicable runtime semantics. A cited artifact must exist, have the declared identity and relate to the selected source/candidate. A line or symbol reference is meaningful only with its pinned file identity. Role assignment and approval scope are checked against the current plan. Structural criterion-to-evidence coverage does not prove the evidence satisfies the criterion; semantic review and independent outcome checks remain necessary.

An actionable issue records the observed problem, applicable requirement, responsible role and required outcome. Future issue-contract extensions should add typed evidence references, tied to the immutable subject, when the current contract cannot express them. Keep the reason for a non-obvious change and all relevant conditions. The existing `message` and `requestedChange` serve different purposes; a brevity rule must not collapse those meanings.

### Criterion-to-evidence acceptance record

Materialize acceptance coverage in a future versioned acceptance schema and durable artifact. It is a required input to acceptance evaluation, not only prose or optional content inside a context package. It can be referenced from the structured acceptance result; existing ReviewDecision schemas do not already contain this contract.

| Item | Required meaning |
| --- | --- |
| Evaluation identity | Schema/version, immutable evaluation reference, applicable specification/policy, exact subject/candidate and the delivery boundary being evaluated. |
| Accepter | Captured role, provider/model/effort binding, Context and attempt provenance; independence evidence when policy requires it. |
| Criterion coverage | One entry per criterion required at this boundary, using its stable ID and normative revision. No required entry may be omitted. |
| Criterion status | `satisfied`, `unsatisfied` or `unverified`, with a concise reason. `unverified` cannot satisfy an acceptance Gate. |
| Evidence | Typed references to current check records, captured artifacts or recorded observations, including source/candidate identity and relevant scenario/excerpt references. |
| Limits | Missing, inconclusive, stale or unavailable evidence and unresolved semantic questions. |

`satisfied` requires current referenced evidence and a substantive judgement that it demonstrates the criterion. `unsatisfied` records an established violation and its evidence. Missing or inconclusive information is `unverified`; it does not establish a subject defect. An agent cannot declare a mandatory criterion inapplicable to avoid coverage. Any change in applicability comes from the recorded requirement/policy revision.

The runtime verifies criterion inventory, boundary, source identities, evidence references and freshness. Semantic review and independent outcome checks establish whether the evidence is sufficient. A schema-valid claim of satisfaction cannot manufacture a passing CheckReport. Certificates reference the validated evaluation and required current approvals. Every criterion required at the selected boundary must be satisfied before acceptance of that boundary.

Candidate acceptance can precede branch delivery without a dependency cycle: candidate-level criteria are evaluated first, while branch-specific criteria are evaluated against actual delivery evidence under [ADR-0005](0005-verified-feature-branch-delivery.md). Candidate acceptance cannot mark those later criteria satisfied in advance.

Output-contract repair consumes the same attempt/time budget as other work under ADR-0003. Malformed JSON is an operational/contract problem, not a fabricated business defect. Preserve the original output and repair history in audit. New result shapes require advertised capability/schema versions; old clients must not guess them.

## 2. Controlled technical English

Apply this proposed style within existing roles, without introducing a separate rewriting agent:

1. Use direct sentences with an explicit actor and action when the actor is not already fixed by the schema.
2. Express one independently actionable instruction or fact per sentence where practical.
3. Preserve conditions, exceptions, ordering, units, uncertainty and acceptance meaning.
4. Use the same defined term for the same concept. Preserve identifiers, file/API names and requirement IDs exactly.
5. Use active voice when it improves clarity.
6. Remove introductions, politeness, filler and repeated conclusions from machine-directed outputs.
7. Do not restate facts already present in structured fields or referenced authoritative artifacts without a specific need.
8. Use MUST/MUST NOT for obligations, SHOULD for recommendations with possible justified exceptions, and MAY for permission. Do not strengthen an uncertain observation into an obligation.
9. Distinguish observed evidence, inference, assumption and unknown information.
10. Prefer concise explanations while retaining enough context to understand and verify a requested change.

These rules are a project communication style, not a claim of formal ASD-STE100 compliance. STE itself permits company/project technical terms; unfamiliar identifiers are not a reason to rename project concepts. See the official [STE description](https://asd-ste100.org/about_STE.html) and [FAQ](https://www.asd-ste100.org/STE_faq.html).

Sentence/output length is a soft target. Do not fail an otherwise valid result solely for exceeding an arbitrary word count or silently truncate required explanations. Automated checks can verify structure, IDs and selected repetition; they cannot certify semantic equivalence or full STE compliance.

Store the style/glossary as versioned prompt assets and include their effective source in invocation provenance. Prompt-affecting changes participate in relevant task/reviewer compatibility fingerprints. Applying the style to an existing specification must not silently revise its requirements; semantic changes return to the Analyst.

## 3. Context packages

Create role- and task-specific packages from captured immutable inputs. Selection follows declared requirements and dependencies, not just filenames changed in a diff or an arbitrary token cap.

| Package element | Required content |
| --- | --- |
| Identity | Version, package digest, exact subject/source/candidate, role, task and attempt bindings. |
| Selection policy | Selector/version, declared review/task scope, reasons for inclusion, required roots and known unresolved dependencies. |
| Normative content | Applicable requirement closure, constraints and necessary shared interfaces/invariants. |
| Source and changes | Selected source files, relevant dependency/consumer interfaces, base-to-candidate changes and exact file identities. |
| Evidence and issues | Current checks and captured outputs, relevant open findings and prior resolutions, with provenance. |
| Availability | Included artifacts/excerpts and retrievable references, omissions and whether additional reads are supported. |
| Context binding | Fresh/continued Context, native session identity and available history/compaction information; unobservable history remains unknown. |

Package production records selected artifacts and hashes. An excerpt records parent identity, range and extraction method. Summaries are auxiliary navigation; requirements and evidence retain an authoritative source. Keep the package record identity separate from its semantic content fingerprint. The latter covers selected content, scope, selection policy and other behavior-affecting inputs; attempt IDs, timestamps and record IDs alone must not invalidate unchanged work. Record the package identity in invocation/review provenance and use the semantic fingerprint for applicable compatibility decisions.

### Package selection determinism and compatibility fingerprinting

Package selection MUST be strictly deterministic from captured inputs, matching the standard ADR-0003 sets for plan selection: stable canonical file ordering, deterministic dependency traversal with tie-breaking, versioned selector rules, and no uncaptured live filesystem reads. Identical captured inputs MUST yield identical semantic package fingerprints. Without this determinism, carry decisions would flap between identical runs.

Today's existing compatibility fingerprints (under M6 / revisions-v1) have no explicit version field, binding the subject hash, scope, role, provider, model, effort, prompt instructions/template slots, and dependency hashes. The contract defines this existing implicit composition as **version 1** (`fingerprint_version: 1`). Any historical or migrated record lacking an explicit version tag is interpreted as version 1.

From the package-contract migration onward, compatibility fingerprints must record their schema version explicitly. Adding the package semantic fingerprint, prompt style version, and glossary version defines **version 2** (`fingerprint_version: 2`). Because v1 and v2 compositions differ and cannot match during carry evaluation, adopting this contract causes a one-time invalidation of approvals carried under pre-package (revision-v1) records upon migration. Old records retain their historical validity until a new revision occurs, but cannot be carried into v2 package-aware executions without re-review.

Suggested role-specific roots are:

- Developer: assigned requirements, task inputs, relevant interfaces, production-code scope, test/check contracts and assigned findings.
- Test Author: requirements, scenarios, interfaces and fixtures needed to verify behavior; implementation details are added when needed for valid tests.
- Code Reviewer: changed implementation, necessary dependency/consumer contracts, requirements and relevant checks.
- Test Reviewer: requirements/scenarios, tests/fixtures, affected implementation interfaces and current check/evidence records.
- Business Analyst at acceptance: original business contract, criterion-to-evidence coverage and unresolved limitations, with access to additional implementation detail when needed.
- Junior Analyst: assigned document defects and the normative references needed to preserve meaning.

These roots are not exhaustive allowlists. Relevant negative paths and shared invariants must remain visible. A simple task can require broad context to verify a critical behavior; a task in a complex workflow can use a narrow local package when global checks cover integration.

References must be resolvable by each supported execution provider through tested file materialization or a supported artifact-read mechanism. The receiving agent must be able to obtain the referenced content. References save repeated transfer only when they avoid unnecessary reads; content actually read still contributes to context use.

Current full/public views remain compatible. A narrow technical-review package requires a new advertised contract; substituting a customer-facing public view for required implementation evidence is not equivalent. The selector must be shared by the runtime/UI/API rather than independently reimplemented in the MCP bridge.

Context selection is not a filesystem sandbox. Full Access agents can have access beyond the selected package. Record observed extra reads when the CLI exposes them; do not claim a complete inventory of operating-system or provider-native reads. Unobserved activity remains an ADR-0002 capture gap.

## 4. Additional context and approval scope

Provide a future typed intermediate context request: requested requirement/artifact/path or question, reason, affected task/review scope and the decision it blocks. Because Managed Agents run as bounded one-shot CLI invocations (`exec` / `-p` / `--print`) with no live channel back to Deszo during the call, and ADR-0001 keeps the authoring MCP bridge out of managed execution, the context request uses an explicit **request as result, then resume** mechanism:

1. When an agent requires additional context, it concludes its invocation turn with a structured `context_needed` result payload.
2. The runtime validates the request against the pinned subject, package policy, and turn limits, materializes the permitted content into the task/turn directory, and records the request/response in audit.
3. The runtime then resumes the managed agent session with the materialized material.

For reviewers requiring a fresh Context, "fresh Context" is defined **per step**: the review step begins in a clean, isolated Context without previous implementation conversation history. Intermediate resumption turns within that same step continue that step's session turn to inspect the newly materialized material.

Each request-and-resume turn counts as an invocation turn against the step's attempt limit and the plan's aggregate attempt and elapsed-time bounds in ADR-0003. Missing or unsupported content yields an explicit unresolved limitation. (A separate read-only context MCP server authenticated per-invocation remains a possible future transport alternative if persistent interactive CLI processes are introduced, but turn-based request-and-resume is the baseline for one-shot CLI adapters).

This request is distinct from the existing ReviewDecision verdict. This ADR does not add a third verdict to the current schema or allow an agent to approve a subject while a blocking information request is unresolved. New request support requires capability negotiation and a bounded turn/read budget. Read limits apply to mediated requests; unobservable native reads cannot be counted as if mediated, and the enclosing managed invocation retains its execution timeout.

Widening a package preserves source identity but changes its package identity. Widening review scope updates the declared scope and applicability fingerprints. An approval covers only the validated declared scope. The Gate must require the policy's complete set of current approvals and checks for acceptance; partial review cannot establish whole-candidate coverage.

A package that cannot establish its required dependency closure requests more information or records an incomplete review. It cannot silently omit a necessary requirement to fit a budget. Additional requests count toward the aggregate bounds in ADR-0003.

### Review execution outcome versus subject verdict

Define `REVIEW_INCOMPLETE` in the future review-execution contract as an outcome of the particular review step, not a third ReviewDecision verdict or a new top-level workflow run state. Record the exact subject/scope, unresolved requests, reason, available diagnostics and budget consumed. Example reasons are context unavailable, retrieval failed/unsupported, or budget exhausted.

A completed review can emit `APPROVED` or `CHANGES_REQUESTED` under the existing domain semantics. An incomplete review has no final subject verdict and supplies no approval for a required review slot. The surrounding run continues, fails or stops only through its existing lifecycle rules. Preserve confirmed findings as evidence without treating incomplete overall coverage as a completed review.

Inside an enclosing loop (such as the Specification Loop or Delivery Loop), `REVIEW_INCOMPLETE` is an operational context limitation, not a subject defect or a `CHANGES_REQUESTED` verdict. It must not consume a loop iteration as if implementation had failed. The loop follows an explicit two-tier rule:

1. If unexhausted turn and aggregate budget remains, retry the review step with a widened context package within the aggregate budget.
2. If automatic widening is not possible or the turn/budget bound is reached, the loop transitions to pause for the user via the existing `waiting_for_user` path (recording the diagnostics, consumed budget, and unresolved context request), rather than consuming iteration limits as a failed repair cycle.

Operational inability to retrieve an existing contract is different from an observed omission in a specification that is required to define that contract. The former produces incomplete review/retrieval diagnostics; the latter can support a real `CHANGES_REQUESTED` decision against the specification. Do not route an operational lack of information to Developer as a fabricated implementation defect.

Resume/reattempt is bounded and pinned to the recorded subject and expanded package. A changed subject uses the normal revision/invalidation path. The future contract must distinguish incomplete review from the associated provider/timeout/cancellation outcome and advertise support before clients emit the new record shape.

## 5. Feedback on changes and carry

For repeated work, assemble the current changes, unresolved issues, resolution evidence and affected requirement/interface closure. Do not repeat all unchanged prose by default. A change to shared contracts can require broader review than the visible file diff suggests.

Use existing subject, scope, configuration and dependency fingerprints to decide whether approvals/task results can carry. The contract defines the current unversioned fingerprint composition as version 1 (`fingerprint_version: 1`). The package-aware contract binds package semantic fingerprints, selector version, prompt style version, and glossary version under `fingerprint_version: 2`, with the version recorded explicitly from the migration onward. Adopting this versioned fingerprint causes a one-time invalidation of pre-package (v1) approvals upon migration. Existing cache, Context and carry rules remain authoritative; a reference or concise summary is not permission to reuse a stale decision.

Record the reason for carrying, reopening or widening each review. Native Context continuation and runtime result carry are separate mechanisms. A long continued session may contain more context than the current package, and changing the package cannot erase earlier native history. Fresh versus continued Context is an explicit plan/experiment parameter, not an invisible optimization.

## 6. Audit and measurement

Keep complete available raw audit independently of what is forwarded to the next agent. Preserve raw results, tool events, prompts, materialized-package manifests, context requests and check evidence under ADR-0002. Short model-facing reports use continuation references; they do not delete original evidence or substitute a summary for captured bytes.

Distinguish these measurements:

| Measure | Meaning |
| --- | --- |
| Provided input | Exact Deszo-generated prompt and selected artifact identities/bytes. This does not prove every available file was read. |
| Observed reads | Tool/file reads visible in provider events or mediated artifact requests, with explicit gaps. |
| Reported usage | Original provider usage and normalized values only when their semantics are known. Separate fresh/cached input, output and reasoning where reported without adding overlapping counters. |
| Estimated usage | Optional tokenizer/byte-based estimate labeled with method/version and coverage. It is not measured provider consumption. |
| Aggregate usage | Per-attempt/per-session/cumulative and child-agent inclusion semantics; avoid double counting cumulative snapshots or reasoning included in output. |
| Outcome and overhead | Independent quality, time, retrieval/repair turns, parse failures and defects caused by missing information. |

Missing usage is unknown, not zero. Record native-history/compaction visibility and caches where reported. Output brevity does not establish a reduction in total native context, reasoning work, subscription quota use or monetary cost. Price estimates, if later added, require a dated source and remain separate from measured tokens.

Token-saving percentages in the supplied discussion are hypotheses. No reduction is promised by this ADR. Context selection and removal of duplication are priorities to investigate; their benefit relative to prose style is established through measurement.

Use ADR-0003's versioned corpus and independent oracle. First record the unmodified baseline, then compare removal of duplicate summaries, role-specific packages/feedback on changes, and controlled prose as separately identifiable variants in that order. Keep bindings/efforts, source inputs and verification criteria fixed within a comparison; disclose Context/cache conditions and repeat runs. Test a deliberately non-obvious dependency and verify that missing context cannot produce a valid whole-result approval. Retain unsuccessful runs and account for extra retrieval turns and preparation overhead.

## 7. Implementation stages and verification

1. Inventory current structured contracts, duplicate prose and actual context delivery. Define metric availability and capture the unchanged measurement baseline before the first optimization. Specify the proposed acceptance/package/request/review-execution contracts without adding unsupported fields to existing strict schemas.
2. Remove duplicate summaries around existing JSON-only results and add schema-validated presentation where needed. Preserve prompt prose style and context selection for this comparison; measure quality, usage and overhead.
3. Add acceptance coverage records, package selection, tested reference retrieval, intermediate requests, incomplete-review semantics and compatibility/invalidation rules through the runtime's advertised API. Preserve full/public views and existing clients. Evaluate context changes separately, including feedback on changes.
4. Add versioned controlled-prose/glossary assets as a later independent experiment, after package delivery and safe context expansion have been verified. Keep models/efforts and selected content fixed for the style comparison.
5. At each increment verify deterministic fixtures and, under separate execution authorization, compare real-provider variants through ADR-0003's evaluation method. Retain per-increment results; no stage assumes a saving from the next one.

| Criterion | Required evidence |
| --- | --- |
| ADR4-01 | Control steps emit one validated authoritative final value; audit retains available progress/tool/raw output separately. |
| ADR4-02 | Structured claims cannot forge runtime check facts or approve a different subject/scope; reference integrity and coverage are validated. |
| ADR4-03 | Style application preserves identifiers, conditions, uncertainty and project language; semantic changes return to the Analyst. |
| ADR4-04 | Packages record exact inputs, selection reasons, omissions, versions and Context binding; package selection is deterministic; each supported provider can retrieve required references. |
| ADR4-05 | Missing dependencies trigger bounded request-and-resume context turns or an explicit incomplete outcome; fresh Context is defined per review step and turns count against aggregate bounds; missing context cannot yield a false complete approval. |
| ADR4-06 | Scope/package changes and shared-contract changes correctly invalidate dependent approvals; the contract defines the current composition as `fingerprint_version: 1` and records versions explicitly from the migration on; adopting package-aware fingerprints (`fingerprint_version: 2`) causes a one-time invalidation of pre-package carried approvals; stale decisions cannot carry through concise feedback. |
| ADR4-07 | Full audit remains available despite narrower handoffs; unobservable reads/native history and missing usage remain explicit gaps. |
| ADR4-08 | Usage normalization avoids cumulative/child/reasoning double counting and distinguishes estimates from provider reports. |
| ADR4-09 | Comparative results include retrieval/repair overhead and independent defect checks; savings are limited to measured cases. |
| ADR4-10 | Legacy workflows and the two current review verdicts remain compatible; new contract support is discoverable and does not change bindings or invoke providers on save. |
| ADR4-11 | A versioned durable acceptance record covers every required criterion at the declared boundary, binds current evidence and cannot approve omitted, stale or unverified criteria. |
| ADR4-12 | Incomplete review is a review-execution outcome with reasons and no final subject verdict; within a loop, incomplete review retries with a wider package within budget then pauses for the user (`waiting_for_user`), without consuming repair iterations; retrieval failures and genuine specification omissions follow different routes without adding a top-level run state. |
| ADR4-13 | The unchanged baseline precedes duplicate removal, packages and controlled prose; comparisons isolate each change and include retrieval/repair overhead and independent quality checks. |

## Consequences and alternatives

Explicit contracts improve inspectability and can reduce duplicate text. Package selection and provenance add engineering work. Overly narrow views, stale summaries and excessive style constraints can increase mistakes or total work; independent outcome checks and on-demand expansion are required to evaluate those risks.

Full formal STE compliance, fixed token-reduction targets, abbreviated opaque field names, hard truncation of required context and forwarding all conversation history to every role are outside this proposal. Full context remains an explicit option when the required scope cannot be safely narrowed. Model/effort changes and a separate prose-rewriting agent are not introduced.

Acceptance of this ADR would approve this architecture only. This documentation request does not authorize runtime/schema implementation, prompt/workflow edits, provider calls or comparative experiments.
