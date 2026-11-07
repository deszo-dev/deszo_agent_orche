# Multi-Provider External Judge: Provider Capability & Billing Matrix

**Date:** 2026-10-21  
**Target:** ADR-0007 (Event-Driven Judge Attention and Compact Evidence)  
**Location:** `docs/reviews/2026-10-21-judge-provider-capabilities.md`  
**Evidence Base:** `docs/reviews/evidence/2026-10-21-multi-provider-judge-poc/`

---

## 1. Executive Capability Comparison

This matrix compares the three candidate AI execution providers for Deszo's external Judge controller role under the core architectural rule:
> **Deszo must use the user's existing AI subscription allowances whenever officially supported, rather than silently switching to separately billed APIs.**

Technical feasibility is strictly separated from official policy authorization.

| Capability / Dimension | OpenAI Codex | Google Antigravity | Anthropic Claude Code |
| :--- | :--- | :--- | :--- |
| **Tested Client Executable** | `codex.exe` (app-server) | `agy.exe` | `claude.exe` |
| **Exact Tested Version** | `0.163.0-alpha.10.2` | `1.4.4` | `2.1.302 (Claude Code)` |
| **Local Binary Availability** | `VERIFIED` (`Local/OpenAI/Codex/bin`) | `VERIFIED` (`Local/agy/bin`) | `VERIFIED` (`WinGet/Links`) |
| **Native Subscription Support** | `VERIFIED` (ChatGPT Plus/Team/Pro) | `VERIFIED` (Consumer Google Account) | `VERIFIED` (Claude Pro/Team) |
| **Third-Party Subscription Eligibility** | `DOCUMENTED` (Restricted by SIWC preview limitations; requires OAuth app registration) | `VERIFIED` (Headless CLI uses Google consumer subscription quota) | `DOCUMENTED` (Prohibited; terms restrict subscription to interactive use) |
| **Headless Execution Mode** | `VERIFIED` (`codex app-server --listen stdio://`) | `VERIFIED` (`agy -p`) | `VERIFIED` (`claude -p`) |
| **Session Persistence** | `VERIFIED` (Rollout `.jsonl` files) | `VERIFIED` (SQLite + JSON conversations) | `DOCUMENTED` (Project session transcripts) |
| **Session Resume by ID** | `VERIFIED` (`thread/resume` in same home) | `VERIFIED` (`--conversation <id>`) | `DOCUMENTED` (`--resume <id>`) |
| **Dedicated Session Isolation** | `VERIFIED` (Separate `CODEX_HOME`) | `VERIFIED` (Dedicated conversation ID) | `DOCUMENTED` (Dedicated project session) |
| **Turn Lifecycle Milestones** | `VERIFIED` (`turn/started`, `turn/completed`) | `VERIFIED` (Structured `result` event) | `DOCUMENTED` (`result`, streaming events) |
| **Turn Started Timing Trap** | `VERIFIED` (`turn/started` emitted on queue admission before remote auth check; 401 follows) | `VERIFIED` (`status: SUCCESS` emitted even when tool is auto-denied in headless mode) | `DOCUMENTED` (API error emitted on completion) |
| **Tool / MCP Integration** | `VERIFIED` (`mcpServerStatus/list`, scoped echo) | `VERIFIED` (`agy mcp`, auto-denies unapproved command tools in headless mode) | `DOCUMENTED` (`--mcp-config`, tool permissions) |
| **Concurrency / Serialization** | `CONTRADICTED` (Turn B dropped if Turn A fails; native queue needs `experimentalApi`) | `DOCUMENTED` (No CLI multi-writer lock; requires Deszo host serialization) | `DOCUMENTED` (No CLI multi-writer lock; requires Deszo host serialization) |
| **Single-Writer Fencing** | `CONTRADICTED` (Thread file lock in same home only; stale generation writes accepted) | `DOCUMENTED` (No native generation fencing; host enforcement required) | `DOCUMENTED` (No native generation fencing; host enforcement required) |
| **Usage Telemetry** | `UNVERIFIED` (No token counts returned in stdio App Server turn events) | `VERIFIED` (Exact token counts: input, output, thinking, cache, total) | `DOCUMENTED` (Cost USD and tokens on stdout/json) |
| **Billing Fallback Risk** | `HIGH` (Presence of `OPENAI_API_KEY` silently routes to metered API billing) | `LOW` (Fails closed if `quotaProject` or `useG1Credits` present; no API fallback) | `CRITICAL` (Headless non-interactive mode strictly requires `ANTHROPIC_API_KEY`) |
| **PoC Verification Status** | `BLOCKED` (POC-C01: no auth in isolated home; SIWC preview bounds) | `PASS` (Turn 1 & 2 succeeded under subscription; denial diagnostics captured) | `POLICY_BLOCKED` (Anthropic policy gate refuses automated subscription use) |
| **Enablement Recommendation** | **Stage 2 Deferred** (Hold for SIWC OAuth or dedicated profile bridge) | **Stage 1 Primary Candidate** (Verified headless subscription & resume) | **Disabled / Unsupported** (Fail closed; no unapproved API key usage) |

---

## 2. Detailed Provider Analysis

### 2.1 OpenAI Codex (Codex App Server)

#### Official Documentation Baseline
- **Sources:**
  - `https://developers.openai.com/siwc/token-sharing-open-source/`
  - `https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server`
  - `https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations`
  - `https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions`
- **Documentation Access Date:** 2026-10-21
- **Tested Version:** `codex-cli 0.163.0-alpha.10.2`

#### Observed vs. Documented Behavior
1. **Authentication Mode:** Native Codex CLI supports `codex login` using a ChatGPT account. In the user's primary profile (`~/.codex`), `codex login status` reports `Logged in using ChatGPT` (`VERIFIED`).
2. **Isolated Environment Blocker:** In an isolated `CODEX_HOME` (required by ADR-0007 dedicated-session isolation), `account/read` returns no account (`VERIFIED`). Attempting model inference triggers an HTTP 401 Unauthorized from the backend.
3. **Turn-Started Milestone Semantics:** The App Server emits `turn/started` synchronously upon enqueuing the request locally, *before* initiating network authentication or model dispatch (`VERIFIED`). Receiving `turn/started` does NOT prove that model inference was authorized or initiated.
4. **Session Ownership & Fencing:** Codex implements native file-based thread writer locks (`thread-writer-locks/`) preventing two live processes in the *same* `CODEX_HOME` from writing concurrently (`VERIFIED`). However, it has no native concept of owner generations: a stale generation from a previous owner can continue writing after a simulated takeover (POC-05 S2: `FAIL`, `VERIFIED`). Deszo's trusted host must enforce admission barriers.
5. **Concurrency & Queueing:** In POC-04, when Turn B was submitted while Turn A was active, Turn B was accepted but never started after Turn A failed (`VERIFIED`). The native queue methods (`thread/queue/add`, `thread/queue/list`) return `-32600: requires experimentalApi capability`.
6. **Billing Mode Compliance:** Third-party automated token sharing under ChatGPT subscriptions is governed by OpenAI's "Sign in with ChatGPT" (SIWC) preview limitations, which require an OAuth Client ID and interactive user consent. Supplying an `OPENAI_API_KEY` silently switches the App Server to metered API billing, violating Deszo's `subscription_only` mandate.

---

### 2.2 Google Antigravity (Antigravity CLI `agy`)

#### Official Documentation Baseline
- **Sources:**
  - `https://antigravity.google/docs/cli/headless/`
  - `https://antigravity.google/docs/install?tab=cli`
  - `https://antigravity.google/docs/plans`
  - `https://antigravity.google/docs/cli/credits/`
  - `https://antigravity.google/docs/cli/commands/usage`
- **Documentation Access Date:** 2026-10-21
- **Tested Version:** `1.4.4`

#### Observed vs. Documented Behavior
1. **Authentication Mode:** Verified via `~/.gemini/antigravity-cli/cli.log`:
   `applyAuthResult: email=..., authMethod=consumer, quotaProject=` (`VERIFIED`). The user is authenticated via OAuth with a personal Google consumer account.
2. **Subscription Quota Verification:** `quotaProject` is empty, confirming no Google Cloud billed project is attached. The settings file (`~/.gemini/antigravity-cli/settings.json`) does not have `useG1Credits` or `modelProvider` enabled (`VERIFIED`). Headless CLI requests consume baseline consumer subscription allowances.
3. **Headless Execution & Resume:**
   - Turn 1 (`agy -p ... --output-format json`): Completed successfully in 15.3s (model duration 3.16s), returning valid JSON `{"judge":"active","provider":"antigravity","decision":"PROCEED"}` with `num_turns: 1` (`VERIFIED`).
   - Turn 2 Resume (`agy -p ... --conversation <id> --output-format json`): Resumed the exact conversation session `d74ebd97-5503-43c5-b797-ee64f93bac70` in 10.6s, returning `num_turns: 2` (`VERIFIED`).
4. **Tool Permission Trap & Diagnostics:**
   - In headless print mode (`-p`), `agy` cannot display interactive terminal permission prompts. Unapproved command tool requests are automatically denied by the runtime (`VERIFIED`).
   - **Crucial Diagnostic Finding:** When a tool was denied, `agy` exited with code `0` and reported `"status":"SUCCESS"`, but returned `"response":""` and explicitly populated `"denied_actions":[{"action":"command","display_name":"RunCommand"}]` (`VERIFIED`).
   - Relying on exit code or status string alone produces false positives. The Deszo adapter must inspect `denied_actions` and response completeness.
5. **Usage Telemetry:** `agy` returns full machine-readable token telemetry in its JSON output:
   `input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens` (`VERIFIED`).
6. **Session Ownership & Fencing:** CLI commands share conversation storage (`~/.gemini/antigravity-cli/conversations/`) and SQLite indexes without native inter-process writer locks. Deszo's trusted host controller queue must serialize turns and enforce single-writer admission.

---

### 2.3 Anthropic Claude Code (Claude Code CLI `claude`)

#### Official Documentation Baseline
- **Sources:**
  - `https://code.claude.com/docs/en/cli-reference`
  - `https://docs.anthropic.com/en/docs/claude-code/getting-started`
  - `https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account`
- **Documentation Access Date:** 2026-10-21
- **Tested Version:** `2.1.302 (Claude Code)`

#### Observed vs. Documented Behavior
1. **Authentication Mode:** `claude auth status --json` confirms:
   `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, `subscriptionType: "pro"` (`VERIFIED`). The user has an active Claude Pro subscription.
2. **CLI Capabilities:** Supports `-p/--print`, `--output-format json`, `--output-format stream-json`, `--resume <id>`, and `--max-budget-usd` (`VERIFIED`).
3. **Mandatory Policy Gate (Restriction):**
   - Anthropic's subscription terms (`support.claude.com`) restrict Claude Pro/Team subscription allowances strictly to direct human interactive development.
   - Anthropic documentation explicitly states for non-interactive / bare mode (`--bare`):
     `Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read).`
   - Third-party automation frameworks, orchestrators, and headless harnesses are NOT authorized to consume consumer Claude Pro subscriptions as a backend inference API (`DOCUMENTED`).
4. **Billing Precedence & Fallback:** Supplying an `ANTHROPIC_API_KEY` enables automated headless operation, but routes all inference through the Anthropic Console API (pay-per-token metered billing).
5. **Fail-Closed Enforcement:** Because Deszo requires `subscription_only` and Anthropic policy forbids subscription-backed automated multi-agent orchestration, Claude Code is classified as `POLICY_BLOCKED` (`UNSUPPORTED`). In compliance with Deszo constraints, **0 inference calls were executed against Claude Code**, preventing unauthorized usage and silent API billing.

---

## 3. Provider Enablement & Readiness Synthesis

| Provider | Technical Feasibility | Policy Authorization | Economic Safety | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **Google Antigravity** | `HIGH` (CLI headless, structured JSON, conversation resume, exact token telemetry verified) | `PERMITTED` (Official consumer OAuth headless CLI usage supported) | `SAFE` (Fail-closed on `quotaProject` and `useG1Credits`) | **Recommended as Primary Judge Adapter** for ADR-0007 Stage 1. |
| **OpenAI Codex** | `MEDIUM` (App Server stdio, MCP tools, thread locks verified; queue & generation fencing missing) | `RESTRICTED` (SIWC preview limitations; requires OAuth app registration) | `UNVERIFIED` in isolated profile (401 without credentials; API key is pay-per-token) | **Deferred to Stage 2.** Complete SIWC registration or dedicated profile bridge before enablement. |
| **Anthropic Claude Code** | `HIGH` (CLI flags, resume, and JSON output exist) | `PROHIBITED` (Terms forbid subscription use for automated third-party backends) | `RISK` (API key required for headless automation; metered billing) | **Disabled / Unsupported.** Maintain policy gate. Do not enable under `subscription_only`. |
