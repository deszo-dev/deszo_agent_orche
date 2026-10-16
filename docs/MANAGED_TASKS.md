# Managed development tasks

Version: 1.0  
Updated: 2026-10-16  
Capability: `task-planning-v1` (with `core-v1` and `loops-v1`)

The `task` node executes the bounded reference workflow from [ADR-0003](adr/0003-task-assessment-and-workflow-planning.md), using [context and acceptance contracts](adr/0004-agent-communication-and-context-contracts.md) and optional [verified local branch delivery](adr/0005-verified-feature-branch-delivery.md). It consumes `request: Text` and an immutable `source: ArtifactSet`; it produces `candidate: ArtifactSet` and `summary: JsonValue` only after acceptance at the configured boundary.

The [reference workflow](examples/managed-task/workflow.json) contains the agreed explicit bindings: Analyst `gpt-6.1-sol/max`, separate Code Reviewer and Test Reviewer `claude-opus-5-5/medium`, Test Author and Developer `claude-haiku-5-5/xhigh`, Junior Analyst `gpt-6-luna/max`. These are configuration, not verified claims about installed CLI availability. Runtime/provider preflight still applies. The empty editor node has blank model IDs so it cannot silently choose a model. Add an explicit `businessAccepter` when policy requires independent acceptance.

## Authoring and execution boundary

Discover `task` through the existing API v3 node catalogue, `managed-task` template and published [schema](schemas/managed-task.schema.json). Validate and conditionally save the workflow with its ETag before execution. Reading, validating, saving or selecting a template does not invoke a provider. The usual external-run confirmation and supervision-grant rules apply when starting it.

Compilation expands a captured, fixed node template into ordinary scoped attempts, as Map expansion already does. The engine selects only the reference stages authorized by that node's saved configuration. It does not accept an agent-authored executable graph or replace the saved workflow during a run. The plan records the captured workflow artifact, execution hash, compiler version, complete configuration fingerprint and selected step descriptors. A change to roles, scopes, policy, checks, bounds or boundary requires a new conditional workflow save and run. Assessment/plan revisions inside the template remain immutable, linked records.

The current compiler executes a task's source bundle in sequence. Existing Implementation Maps remain available for explicitly authored decomposed workflows. This increment does not claim automatic parallel Map decomposition or measured efficiency across all seven corpus classes; those remain evaluation/extension boundaries.

## Selected stages

1. Analyst captures requirements, criterion IDs, evidence producers, axes and unknowns against the immutable business request and source identity.
2. A fresh Code Reviewer confirms the assessment before any reference stage may be omitted. The selector is deterministic after the assessment, source-policy facts, bindings and configuration are captured. Undeclared critical-area policy fails closed to full stages.
3. Material uncertainty triggers bounded discovery and reassessment. Full plans add separate code/test readiness reviews. A declared test scope always invokes Test Author and Test Reviewer before Developer. Junior Analyst can edit only the declared documentation scope, with instructions limited to nonsemantic fixes.
4. The engine captures each writer's actual source changes and rejects writes outside its scope. Review and assessment workspaces are read-only by contract: any source mutation invalidates that result. Separate logical steps receive separate directories and native Context bindings; final business acceptance starts fresh.
5. Assembly compares the actual diff with the original source and policy floors. A newly observed critical/public-contract change creates an escalated plan revision, invalidates old evidence selection and runs the additional stages before final review.
6. Configured commands run on the assembled candidate. Their IDs must map to captured acceptance criteria. Complete failing checks go to Analyst triage before bounded implementation/test/requirements repair. Timeouts, capture failures, missing dependencies and unknown/environment causes pause as incomplete; they are not code-review findings.
7. Separate code/test delivery reviews precede business acceptance. Acceptance covers the exact criterion inventory. The engine resolver verifies each evidence reference against its content digest, subject, candidate, plan revision, criterion and boundary. An agent assertion or schema-valid record alone cannot accept a candidate.
8. A `verified_branch` task then performs delivery and verifies a second acceptance boundary. A `candidate` task finishes with immutable artifacts and implies no application, commit, merge, push or release.

Assembly observations are separate immutable state receipts, not edits to an already recorded plan document. `candidateFloorEvaluation` must pass for the active plan revision and exact candidate before acceptance. Assessment/discovery revisions keep one stable plan identity; superseded revisions and completed status remain distinct projections. Canonical package/source ordering does not depend on the host locale.

## Context retrieval and evidence

Each invocation receives one JSON result contract and a role-specific package in `.deszo-context/package.json`, with captured input in `.deszo-context/input.json`. Packages bind source digests, request/assessment/policy, feedback and selected evidence. Duplicate prose summaries are not requested. Compatibility fingerprint version 2 includes the semantic package; legacy approvals cannot be carried into this path. The managed task currently creates fresh review results rather than reusing legacy Gate certificates.

Check evidence includes command/exit/capture metadata, stream manifests and a preview of up to 64 KiB per stream. The evidence catalogue names exact captured chunks. `CONTEXT_NEEDED` may name a captured source path or a catalogue `evidence:<artifactId>:<stream>:<index>` request. The engine materializes the authorized dependency and resumes the same CLI Context in a new ordinary attempt. The expanded package and fingerprint are journaled. Missing/unsupported dependencies or exhausted retrieval bounds become `REVIEW_INCOMPLETE` and `waiting_for_user`, without consuming a repair iteration. Required source is never replaced by an invented summary.

This is process/work-directory isolation, not an operating-system filesystem sandbox. Configured agents and commands retain the operating system account's permissions. Full CLI-exposed output is captured; unavailable private model reasoning is not inferred.

## Bounds, Stop and recovery

All preparation, discovery, Context turns, agent repairs, triage, configured verification, delivery operations and delivery smoke share `maxAttempts` and a wall-clock `maxElapsedSeconds` deadline. The deadline includes queue and user-wait time and cannot reset on retry. A delivery operation costs one attempt and each smoke check costs one; its individual Git plumbing commands cost zero additional attempts but remain bounded, captured process/work records. Reserved attempts, actual launched processes, bytes, durations and repair counts are distinct metrics. Process duration totals are not wall time or provider token usage.

Completed/canceled elapsed timing freezes at the terminal attempt/work observation rather than growing when history is inspected. Restart-derived durations are labeled `recovery_upper_bound`, because the runtime cannot reconstruct the exact unobserved termination time. A parent task instance cannot be retried/restarted in the same run to obtain a fresh aggregate budget; recover its current step or capture a new run.

Git and smoke use the same `launchContained` path, process registry, native run Job when present, journal and durable stream capture as Agents. Each command has its own ordinary attempt, command manifest, execution evidence and stdout/stderr closure. The 16 MiB protocol buffer is separate from the 256 MiB-per-stream audit capture bound. Crossing a capture/protocol limit cannot yield accepted evidence. Each `timeoutMs` is capped by the remaining task deadline.

Root Stop, scoped task Stop and an enclosing Loop Stop propagate to running utility children. `stop-and-report` retains its independent termination/capture/incident outcomes. Standalone fixtures can demonstrate process-tree termination, but do not manufacture a native Job termination proof. Supervised control still requires the exact supported client matrix and native supervisor from [ADR-0002](adr/0002-execution-audit-and-supervised-control.md).

Restart marks active tasks and attempts interrupted. Unfinished delivery intents become `reconciliation_required`; intent and latest receipt remain readable. Recovery never automatically reapplies a candidate, commits or updates a ref. Retry after a delivery intent is refused until the operator inspects/reconciles the saved commit/ref receipt and creates a newly captured run. Fresh Context recovery creates a new directory and binding; exhausted aggregate limits remain exhausted.

## Verified branch inputs

Set `delivery.boundary` to `verified_branch` with an exact `baseCommit`, `targetBranchRef` under `refs/heads/codex/`, an explicit `expectedOldValue` (null only for an absent branch), and commit identity/message. Capture **all regular files** from the declared Git base as the source ArtifactSet. Partial, uncommitted, symlink/submodule or mismatching base snapshots are refused before development. For an existing feature branch, capture its current recorded head as the intended base/expected head.

Delivery supports byte-identical binary contents, deletions and base executable modes through manifest version 2. It uses a fresh owned separate clone with `--reference --dissociate`, explicit hook policy, exact staged/committed tree verification and smoke checks. It refuses an already checked-out target branch or changed ref. A repository/ref lock coordinates deliveries within this runtime; the final ref update is compare-and-swap. Host fetch/update-ref disable ambient hooks and leave the caller's worktree/index untouched.

Durable `intent`, commit and publication receipts precede/record the relevant mutations. A timeout/abort with an indeterminate ref-update result is `publication_uncertain`, not success. A Stop racing with a successful update records that the ref changed without publishing readiness. An external checkout starting after the last precondition check remains a disclosed Git race; no exclusive lock over unrelated Git clients is claimed.

## Inspecting a run

- UI: **Managed Task** palette entry, configuration inspector and live phase/plan/budget/delivery status. Ordinary attempts and captured streams remain available in run history/Replay.
- HTTP: `GET /api/v2/runs/{runId}/tasks/{encodedNodeInstanceId}` returns the durable assessment, selected plan, current phase, work totals, incomplete reason, acceptance IDs, delivery operation and immutable state reference.
- MCP: `get_managed_task`, `get_run_processes`, `get_run_evidence`, `watch_run`, bounded artifact reads and audit export. Execution-enabled bridges also expose `stop_node`, `stop_run` and `stop_and_report`. Authoring-only bridges expose no execution/Stop tools.
- Offline: private audit bundles include `tasks.json`, assessments/plans/acceptance/delivery/work records and the transitive immutable artifact closure. Shareable exports omit binary/raw stream objects and disclose that omission.

## Verification and experiments

The [managed-task tests](../runtime/tests/managed-task.test.mjs) exercise real Engine dispatch with deterministic CLI fixtures, actual check subprocesses and temporary Git repositories. They cover accepted candidate/branch results, discovery and actual-diff escalation, source/evidence retrieval, repair, independent acceptance, incomplete reviews, scope/mutation rejection, shared bounds, running-child Stop and durable restart reconciliation. They do not establish real model quality or savings.

Use the recorded work and audit data for the separate [ADR-0003 evaluation](adr/0003-task-assessment-and-workflow-planning.md#5-evaluation-method). Provider comparisons and controlled-prose experiments retain their separate authorization boundary and order: baseline, duplicate removal, packages, then prose. No real-provider campaign or shadcn/ui migration is started by this implementation.
