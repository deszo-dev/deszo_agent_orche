# Multi-Provider External Judge Verification PoC

**Document Date:** 2026-10-21  
**Target:** ADR-0007 (Event-Driven Judge Attention and Compact Evidence)  
**Location:** `docs/reviews/evidence/2026-10-21-multi-provider-judge-poc/`

## Objective

Verify the technical feasibility, session ownership, and billing policy compliance of using external AI provider CLI tools as an event-driven Judge controller for Deszo, adhering to the foundational constraint:
> **Deszo should use the user's existing AI subscription allowances whenever officially supported, rather than silently switching to separately billed APIs.**

## Tested Providers & Environments

| Provider | Client Executable | Tested Version | Authentication Source | Permitted Billing Mode | Policy Status |
| --- | --- | --- | --- | --- | --- |
| **OpenAI Codex** | `codex.exe` (bundled App Server) | `0.163.0-alpha.10.2` | ChatGPT Subscription (`~/.codex`) | `subscription` (ChatGPT) | `BLOCKED` (SIWC preview limitations in isolated profile) |
| **Google Antigravity** | `agy.exe` | `1.4.4` | Consumer Google Account OAuth | `subscription` (Google quota) | `PASS` (Headless turn & resume verified) |
| **Anthropic Claude Code** | `claude.exe` | `2.1.302 (Claude Code)` | Claude.ai OAuth (`claude.ai`) | `subscription` (Claude Pro) | `POLICY_BLOCKED` (Third-party automated usage restricted) |

## Classification Taxonomy

- `VERIFIED`: Directly demonstrated through bounded live execution.
- `DOCUMENTED`: Authoritatively supported by current official provider documentation.
- `UNVERIFIED`: Not sufficiently demonstrated under current test environment.
- `CONTRADICTED`: Inconsistent with observed system behavior.

### Outcome Statuses

- `PASS`: Requirement or check passed with authoritative evidence.
- `FAIL`: Requirement or check failed or contradicted expected behavior.
- `BLOCKED`: Precondition or credentials unavailable; cannot safely proceed without user action.
- `INCONCLUSIVE`: Condition cannot be observed live without arbitrary or disruptive delays.
- `POLICY_BLOCKED`: Technically feasible command exists, but explicitly prohibited or restricted by provider subscription policies.

## How to Reproduce

Run the multi-provider verification suite:

```bash
node docs/reviews/evidence/2026-10-21-multi-provider-judge-poc/run-multi-provider-poc.mjs
```

### Result Artifacts

The run produces machine-readable JSON receipts under `results/`:
- `results/POC-CODEX.json`: Capability inspection, auth status, 401 root cause, and reconciliation of POC-01..08.
- `results/POC-ANTIGRAVITY.json`: Auth and billing validation, headless turn 1 execution, conversation resume (turn 2), permission denial check, and exact token usage telemetry.
- `results/POC-CLAUDE.json`: Capability inspection, auth status, and fail-closed policy gate enforcement.
- `results/summary.json`: Aggregated summary across all three providers.
