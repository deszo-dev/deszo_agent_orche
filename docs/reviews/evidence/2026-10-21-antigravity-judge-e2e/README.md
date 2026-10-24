# Deszo ADR-0007 — Google Antigravity Judge End-to-End PoC

## Overview

This directory contains the complete, reproducible Proof of Concept demonstrating that **Google Antigravity CLI (`agy`)** can operate as an external, event-driven **Judge** controller for Deszo workflows under **ADR-0007: Event-Driven Judge Attention and Compact Evidence**.

The PoC exercises real end-to-end integration:
- Durable attention requests emitted by Deszo.
- Scoped MCP tool evidence retrieval via stdio (`deszo-evidence` server).
- Strict JSON Schema output enforcement (`--json-schema`).
- Authority-boundary validation by an authoritative Deszo Engine validator (`judge-validator.mjs`).
- State transitions (`IN_REVIEW` -> `COMPLETED`, `IN_REVIEW` -> `IN_REVISION`).
- Multi-turn conversation continuation (`--conversation <id>`).
- Serialized queueing (`queued_behind_active_turn`).
- Adversarial prompt injection resistance & crash recovery persistence.
- Complete token accounting under the user's personal Google account subscription allowance without metered GCP billing.

---

## Directory Structure

```text
2026-10-21-antigravity-judge-e2e/
├── README.md                          # This file: test plan, usage, reproduction guide
├── fixtures/
│   ├── judge-decision.schema.json      # JSON Schema enforced on Antigravity CLI output
│   └── test-schema.json               # Baseline structured output test schema
├── lib/
│   ├── evidence-mcp-server.mjs        # Read-only stdio MCP evidence server
│   ├── judge-session-manager.mjs      # Durable attention requests & CLI session adapter
│   └── judge-validator.mjs            # Authoritative Deszo Engine validation module
├── reports/
│   └── antigravity-judge-e2e-summary.json  # Machine-readable test execution report
├── scripts/
│   └── run-antigravity-judge-e2e.mjs  # Complete test suite runner (Experiments A-F)
└── traces/
    ├── exp-a-baseline.json            # CLI version, auth profile, billing settings
    ├── exp-b-mcp-retrieval.json       # MCP tool calls, output verification, denial test
    ├── exp-c-validation.json          # Positive application + 9 negative invariant checks
    ├── exp-d-lifecycle.json           # Session continuation & serialized queueing
    ├── exp-e-security.json            # Adversarial injection & crash recovery traces
    ├── exp-f-telemetry.json           # Turn latencies, tokens consumed, zero cloud cost
    ├── mcp-audit.log                  # Real audit log of MCP tools invoked by agy
    ├── turn-1-result.json             # Live Turn 1: Passing fixer task review
    ├── turn-denial-result.json        # Live Turn 2: Unpermitted tool denial probe
    ├── turn-3-followup-result.json    # Live Turn 3: Failing fixer task review
    └── turn-adversarial-result.json   # Live Turn 4: Adversarial prompt injection attempt
```

---

## Prerequisites & Permissions Setup

1. **Antigravity CLI**: `agy 1.4.4` installed at `~\AppData\Local\agy\bin\agy.exe`.
2. **Authenticated Google Account**: Verified personal account (`authMethod=consumer`, `quotaProject=""`).
3. **MCP Server Registration**:
   Register `deszo-evidence` in `~/.gemini/config/mcp_config.json`:
   ```bash
   agy mcp add --type stdio deszo-evidence "C:\Program Files\nodejs\node.exe" "C:\my\2026\deszo_agent_orche\docs\reviews\evidence\2026-10-21-antigravity-judge-e2e\lib\evidence-mcp-server.mjs"
   ```
4. **Settings Configuration** (`~/.gemini/antigravity-cli/settings.json`):
   Antigravity CLI requires allowing the MCP server in `settings.json` (written in UTF-8 **without BOM**):

```json
{
  "permissions": {
    "allow": [
      "mcp(deszo-evidence/*)"
    ]
  }
}
```

   > [!IMPORTANT]
   > Do NOT pass `--dangerously-skip-permissions`. By adding `mcp(deszo-evidence/*)` to `permissions.allow`, headless Antigravity (`agy -p`) executes permitted MCP tools natively while strictly denying all unpermitted shell commands and unauthorized tools.

---

## How to Run the Tests

Execute the complete automated end-to-end verification suite:

```bash
node docs/reviews/evidence/2026-10-21-antigravity-judge-e2e/scripts/run-antigravity-judge-e2e.mjs
```

The runner will:
1. Attest CLI and subscription authentication (Exp A).
2. Dispatch Turn 1, invoking `read_evidence_package` via MCP, receiving an `APPROVE` verdict (Exp B).
3. Dispatch Turn 2, attempting an unpermitted shell command to verify auto-denial (Exp B).
4. Run the Engine Validator on Turn 1, followed by 9 negative invariant checks (Exp C).
5. Dispatch Turn 3 resuming the session via `--conversation`, reviewing failing tests and returning `REVISE` (Exp D).
6. Dispatch concurrent requests to verify serialized queueing (`queued_behind_active_turn`) (Exp D).
7. Dispatch an adversarial prompt injection request, proving prompt isolation and validator enforcement (Exp E).
8. Verify durable crash recovery persistence across worker restarts (Exp E).
9. Collate all telemetry, latency, token consumption, and verify $0.00 metered API cost (Exp F).
10. Write summary to `reports/antigravity-judge-e2e-summary.json`.

---

## Invariant Ledger

| Invariant | Enforced By | Verified In | Result |
|---|---|---|---|
| Judge is external controller, not an Agent node | Architecture / Adapter | Exp A, B | VERIFIED |
| Engine retains sole authority over state transitions | `judge-validator.mjs` | Exp C | VERIFIED |
| Model output untrusted until validated | `judge-validator.mjs` | Exp C, E | VERIFIED |
| No `--dangerously-skip-permissions` | Adapter Invocation Builder | Exp A, B | VERIFIED |
| Scoped tool execution only | `settings.json` + MCP Server | Exp B | VERIFIED |
| Unpermitted actions denied | Antigravity CLI soft-denial | Exp B | VERIFIED |
| No budget expansion by Judge | Schema + `judge-validator.mjs` | Exp C, E | VERIFIED |
| Idempotent decision delivery | `appliedReceipts` ledger | Exp C | VERIFIED |
| Multi-turn session continuation | `agy --conversation <id>` | Exp D | VERIFIED |
| Serialized turn queueing | `judge-session-manager.mjs` | Exp D | VERIFIED |
| Zero metered GCP API billing | Consumer Google Account OAuth | Exp A, F | VERIFIED |
