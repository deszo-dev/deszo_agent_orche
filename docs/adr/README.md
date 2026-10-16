# Architecture Decision Records

ADRs record architecture decisions and their rationale. The [decision register](../DECISIONS.md) owns requirement and proposal acceptance; an ADR's implementation and verification status must be recorded separately from design acceptance.

| ADR | Date | Status | Subject |
| --- | --- | --- | --- |
| [ADR-0001](0001-external-workflow-authoring-api-and-mcp.md) | 2026-10-15 | Accepted | External workflow authoring through the runtime API and a shared MCP bridge for Codex, Claude Code, and Antigravity |
| [ADR-0002](0002-execution-audit-and-supervised-control.md) | 2026-10-16 | Accepted | Execution audit, supervised external run control, verified root Stop, and local product incidents |
| [ADR-0003](0003-task-assessment-and-workflow-planning.md) | 2026-10-16 | Accepted | General development workflow, task assessment, explainable planning and comparative evaluation |
| [ADR-0004](0004-agent-communication-and-context-contracts.md) | 2026-10-16 | Accepted | Structured agent results, controlled technical prose, context packages and measured communication efficiency |
| [ADR-0005](0005-verified-feature-branch-delivery.md) | 2026-10-16 | Accepted | Exact-candidate delivery to a verified local feature-branch commit, environment evidence and recoverable readiness |

New records use a stable numbered filename. An accepted record keeps its history; a later architecture change should identify the record it supersedes.

Implementation details and limits: [managed tasks](../MANAGED_TASKS.md), [ADR-0003 status](0003-implementation-status.md), [ADR-0004 status](0004-implementation-status.md), [ADR-0005 status](0005-implementation-status.md).
