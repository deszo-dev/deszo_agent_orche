# Architecture Decision Records

ADRs record architecture decisions and their rationale. The [decision register](../DECISIONS.md) owns requirement and proposal acceptance; an ADR's implementation and verification status must be recorded separately from design acceptance.

| ADR | Date | Status | Subject |
| --- | --- | --- | --- |
| [ADR-0001](0001-external-workflow-authoring-api-and-mcp.md) | 2026-10-15 | Accepted | External workflow authoring through the runtime API and a shared MCP bridge for Codex, Claude Code, and Antigravity |
| [ADR-0002](0002-execution-audit-and-supervised-control.md) | 2026-10-16 | Accepted | Execution audit, supervised external run control, verified root Stop, and local product incidents |
| [ADR-0003](0003-task-assessment-and-workflow-planning.md) | 2026-10-16 | Accepted | General development workflow, task assessment, explainable planning and comparative evaluation |
| [ADR-0004](0004-agent-communication-and-context-contracts.md) | 2026-10-16 | Accepted | Structured agent results, controlled technical prose, context packages and measured communication efficiency |
| [ADR-0005](0005-verified-feature-branch-delivery.md) | 2026-10-16 | Accepted | Exact-candidate delivery to a verified local feature-branch commit, environment evidence and recoverable readiness |
| [ADR-0006](0006-time-bounded-autonomy-and-application-lifecycle.md) | 2026-10-20 | Proposed | Persistent time-bounded approvals and unattended rebuild/restart; Windows LocalService/service-SID and independent interactive-launcher direction accepted, subject to implementation verification (superseded by ADR-0008 if accepted) |
| [ADR-0007](0007-event-driven-judge-attention-and-compact-evidence.md) | 2026-10-21 | Proposed | Event-driven Judge requests with dedicated/interactive session ownership, verified turn start, durable decisions and compact evidence; routine work without Judge model polling (superseded by ADR-0009 if accepted) |
| [ADR-0008](0008-portable-ephemeral-lifecycle-host.md) | 2026-10-22 | Proposed | Portable lifecycle host in Rust + Dioxus Desktop, revocable Owner Token, exclusive Judge lifecycle authority, and Suspend-Repair-Restart-Resume continuation without step replay (supersedes ADR-0006 if accepted) |
| [ADR-0009](0009-workflow-native-judge-and-exclusive-external-input.md) | 2026-10-22 | Proposed | Workflow-native Judge role, exclusive external-input boundary, zero-polling wait states via waiting_for_user, deterministic no-progress protection, and workflow-native supervision mode (supersedes ADR-0007 if accepted) |

New records use a stable numbered filename. An accepted record keeps its history; a later architecture change should identify the record it supersedes.

ADR-0007 implementation is separately tracked by the [Antigravity Stage 1 report](../reviews/2026-10-21-antigravity-stage1-report.md) and [bounded contract](../authoring/JUDGE_STAGE1.md). The native/provider E2E gate remains blocked and the ADR remains Proposed.

The [universal monitoring and configurable Decision Authority proposal](../reviews/2026-10-23-universal-agent-monitoring-and-decision-authority-proposal.md) preserves historical amendments A01–A13. The [decision register](../DECISIONS.md#proposed-resolutions) tracks current proposals P33–P40 separately. Neither document changes an accepted ADR's effective contract; replacing D31's designated Judge, changing ADR-0003's hard bounds and adopting Process Custody each require separate decisions.

Proposed 2026-10-23 amendment sections now live in [ADR-0001](0001-external-workflow-authoring-api-and-mcp.md) (full public API authority of Owner Token, direct Run, Publication and migration), [ADR-0002](0002-execution-audit-and-supervised-control.md) (invocation health and conditional Custody), [ADR-0003](0003-task-assessment-and-workflow-planning.md) (lineage budgets and separate Stage 1B), [ADR-0004](0004-agent-communication-and-context-contracts.md) (verified restricted arbiter), [ADR-0008](0008-portable-ephemeral-lifecycle-host.md) (protected Self-Repair and Host), and [ADR-0009](0009-workflow-native-judge-and-exclusive-external-input.md) (versioned decision authority and external questions). An Owner Token authenticates public API calls; it does not attest internal Engine/Host protocol origin. These sections are reviewable future contracts, not adopted changes to the ADR statuses above.

Implementation details and limits: [managed tasks](../MANAGED_TASKS.md), [ADR-0003 status](0003-implementation-status.md), [ADR-0004 status](0004-implementation-status.md), [ADR-0005 status](0005-implementation-status.md), [ADR-0006 status: fixture-verified authority core and pending Windows gates](0006-implementation-status.md).
