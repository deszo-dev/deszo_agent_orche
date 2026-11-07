# Multi-Provider External Judge: Subscription Verification, ADR Amendments, and Feasibility PoC Report

**Date:** 2026-10-21  
**Target:** ADR-0007 (Event-Driven Judge Attention and Compact Evidence)  
**Location:** `docs/reviews/2026-10-21-multi-provider-judge-poc-report.md`  
**Related Documents:**
- [Provider Capability Matrix](2026-10-21-judge-provider-capabilities.md)
- [Amended ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md)
- [PoC Evidence Directory](evidence/2026-10-21-multi-provider-judge-poc/)
- [Baseline Verifier Receipt](evidence/2026-10-21-adr-0007-baseline.json)

---

## 1. Executive Summary

This investigation resolves the central architectural and economic question for Deszo's external Judge controller:
> **Can Deszo reliably and legitimately invoke OpenAI Codex, Google Antigravity, or Anthropic Claude Code as an external event-driven Judge, using existing subscription allowances where officially supported, without weakening execution safety, session ownership, auditability or billing guarantees?**

Based on independent analysis of official provider documentation, reconciliation of historical Codex App Server experiments, and actual live executions with the installed tools on Windows (`codex-cli 0.163.0-alpha.10.2`, `agy 1.4.4`, and `claude 2.1.302`), the findings are:

1. **Google Antigravity is technically proven and policy-compliant as the primary Stage 1 Judge adapter (`PASS`).**
   - Headless print mode (`agy -p`) executed a real structured JSON completion in 15.3s (model inference duration 3.16s), consuming the user's active personal Google consumer account subscription quota (`authMethod=consumer`, `quotaProject=`, `useG1Credits: false`).
   - Conversation resume was directly verified using `--conversation <id>`, successfully resuming the session across turns (turn 2 duration 10.6s) with complete multi-turn history.
   - Exact machine-readable token telemetry (`input_tokens`, `output_tokens`, `thinking_tokens`, `total_tokens`) was captured from the JSON payload.
   - **Crucial Diagnostic Finding:** Headless print mode automatically denies unapproved command tools without an interactive prompt. The CLI returns exit code `0` and `"status":"SUCCESS"`, but with `"response":""` and `"denied_actions":[{"action":"command","display_name":"RunCommand"}]`. Relying on process exit codes or status strings produces false positives; Deszo's adapter must verify payload completeness and inspect `denied_actions`.
2. **OpenAI Codex is technically verified for local App Server primitives, but is blocked for subscription execution in isolated environments (`BLOCKED`).**
   - The previously reported HTTP 401 Unauthorized in POC-03 was reconciled: an isolated `CODEX_HOME` possesses no authentication tokens (`account/read` returns empty). The App Server emits `turn/started` locally upon queue admission before remote dispatch, creating a false turn-start indication before failing with HTTP 401.
   - While the user's primary profile (`~/.codex`) is logged in via ChatGPT (`codex login status` reports `Logged in using ChatGPT`), OpenAI's "Sign in with ChatGPT" (SIWC) and Token Sharing preview terms prohibit third-party orchestrators from extracting or proxying consumer tokens without registered OAuth client credentials.
   - Stale-owner fencing is missing natively (Codex accepts writes from superseded owner generations, POC-05 S2: `FAIL`), and concurrent turns submitted while another is active are dropped if the first turn fails (POC-04: `FAIL`). Host-level admission barriers and serialized queues are mandatory. Codex enablement is deferred to Stage 2.
3. **Anthropic Claude Code is policy-blocked for automated subscription orchestration (`POLICY_BLOCKED`).**
   - The user possesses an active Claude Pro subscription (`claude auth status --json` confirms `loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro"`).
   - However, Anthropic's official terms explicitly restrict Claude Pro/Team subscriptions to personal interactive development. Non-interactive bare mode (`--bare`) strictly mandates `ANTHROPIC_API_KEY` (metered API billing).
   - Under Deszo's `subscription_only` mandate, automated headless multi-agent orchestration via consumer Claude Pro subscriptions is `UNSUPPORTED`.
   - In accordance with fail-closed requirements, **zero inference requests were initiated against Claude Code**, preventing unauthorized usage and unapproved API billing.

---

## 2. Repository Baseline

The Deszo repository currently defines:
- **Developer and Watcher Workflow Roles:** Managed under [ADR-0004](../adr/0004-agent-communication-and-context-contracts.md) and [ADR-0006](../adr/0006-time-bounded-autonomy-and-application-lifecycle.md), executing via headless CLI wrappers (`runtime/core/adapters.mjs`). `subscriptionEnvironment()` removes metered API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`) to prevent silent billing fallbacks.
- **The Judge Role:** Defined in [ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md) as an **external registered controller session**, not an internal workflow Agent node.
- **Baseline Overhead:** Confirmed via `docs/reviews/evidence/2026-10-21-adr-0007-baseline.mjs`: the legacy Fixer run generated 781 journal events, 689 log chunks (88.2%), and 21 saved observation batches under a 180s periodic attention timer. Compact evidence and event-driven attention eliminate routine log polling while preserving full audit history.
- **Repository Health:** The entire repository test suite (613 subtests across 43 test suites in `runtime/tests/`) passes with 0 failures (`npm test` exited 0). Documentation checks (`npm run docs:check`) validate 104 markdown documents, 1,003 local links, and 29 schemas with 0 errors.

---

## 3. Official Documentation Findings

Authoritative documentation for all three providers was reviewed on 2026-10-21:

### 3.1 OpenAI Codex
- **Documentation Sources:**
  - `https://developers.openai.com/siwc/token-sharing-open-source/`
  - `https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server`
  - `https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations`
  - `https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions`
- **Key Findings:**
  1. *Token Sharing Preview Restrictions (`DOCUMENTED`):* OpenAI's SIWC framework allows open-source and third-party tools to share ChatGPT subscriptions only through registered OAuth clients with explicit user consent. Direct token extraction or running unauthenticated App Server daemons in custom directories is unauthorized.
  2. *API Fallback (`DOCUMENTED`):* Setting `OPENAI_API_KEY` switches Codex to pay-per-token API billing, bypassing subscription allowances.
  3. *App Server Lifecycle (`VERIFIED`):* JSON-RPC over `stdio://` supports `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, and `turn/steer`. However, `thread/queue/*` requires `experimentalApi`.

### 3.2 Google Antigravity
- **Documentation Sources:**
  - `https://antigravity.google/docs/cli/headless/`
  - `https://antigravity.google/docs/install?tab=cli`
  - `https://antigravity.google/docs/plans`
  - `https://antigravity.google/docs/cli/credits/`
  - `https://antigravity.google/docs/cli/commands/usage`
- **Key Findings:**
  1. *Account & Quota Tiers (`DOCUMENTED` & `VERIFIED`):* Antigravity CLI uses the user's personal Google account OAuth token (`authMethod=consumer`). Headless invocations consume the baseline subscription quota without separate API metering when `quotaProject` is empty.
  2. *Headless CLI Execution (`VERIFIED`):* Running `agy -p <prompt> --output-format json` emits structured JSON results containing `conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, and `usage`.
  3. *Credit Overage Controls (`DOCUMENTED` & `VERIFIED`):* Credit consumption is governed by `useG1Credits` in `~/.gemini/antigravity-cli/settings.json`. If `false` or absent, the CLI operates strictly under subscription allowances and fails closed rather than purchasing credits.
  4. *Tool Permissions in Headless Mode (`VERIFIED`):* The headless CLI does not display interactive TUI permission modals. If the model invokes an unapproved tool (e.g. `command`), the runtime auto-denies the tool and reports `"denied_actions"`.

### 3.3 Anthropic Claude Code
- **Documentation Sources:**
  - `https://code.claude.com/docs/en/cli-reference`
  - `https://docs.anthropic.com/en/docs/claude-code/getting-started`
  - `https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account`
- **Key Findings:**
  1. *Subscription Usage Policy Gate (`DOCUMENTED`):* Claude Pro/Team subscriptions are authorized exclusively for personal interactive developer use. Anthropic's documented policy prohibits external orchestrators from using subscription allowances as a programmatic backend.
  2. *Bare / Non-Interactive Authentication (`DOCUMENTED`):* Documentation for `--bare` specifies: `"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)."`.
  3. *API Precedence (`DOCUMENTED`):* Headless programmatic invocation requires an Anthropic Console API key, which incurs metered per-token billing.

---

## 4. Authentication and Billing

Deszo's architecture mandates an explicit distinction between five authorization dimensions:
1. **Provider Authentication:** Validity of stored credentials or OAuth session.
2. **Subscription Eligibility:** Whether the account tier grants subscription-backed CLI/App Server execution.
3. **Actual Billing/Quota Source:** Whether an invocation consumes subscription allowance, metered API tokens, or purchased credit overages.
4. **Deszo Aggregate Budgets:** Local engine/host limits on attempts, time, and controller invocations.
5. **Model and Tool Permissions:** Scoped MCP capabilities and sandbox controls.

### Provider Status under `subscription_only` Policy

| Provider | Authentication Confirmed | Quota Source Confirmed | Paid Overages Disabled | API Fallback Blocked | Policy Gate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Google Antigravity** | `YES` (Consumer Google OAuth) | `YES` (Consumer subscription quota) | `YES` (`useG1Credits` inactive) | `YES` (No `quotaProject` or API key) | `PASS` |
| **OpenAI Codex** | `PARTIAL` (Default profile yes; isolated home no) | `UNVERIFIED` in isolated profile (fails with 401) | `YES` (No credits configured) | `YES` (`OPENAI_API_KEY` stripped by Deszo) | `BLOCKED` (SIWC preview limitations) |
| **Anthropic Claude Code** | `YES` (Claude Pro via `claude.ai`) | `PROHIBITED` for automated orchestration | `N/A` | `YES` (`ANTHROPIC_API_KEY` stripped by Deszo) | `POLICY_BLOCKED` (Terms prohibit automated sub use) |

---

## 5. Provider PoC Results

Execution evidence was produced via `docs/reviews/evidence/2026-10-21-multi-provider-judge-poc/run-multi-provider-poc.mjs` and stored in `results/`:

### 5.1 Google Antigravity (`PASS`)
- **Turn 1 (Initial Admission & Start):**
  - Prompt: `Do not use any tools. Return only the JSON object: {"judge":"active","provider":"antigravity","decision":"PROCEED"}`
  - Output: `{"conversation_id":"d74ebd97-5503-43c5-b797-ee64f93bac70","status":"SUCCESS","response":"{\"judge\":\"active\",\"provider\":\"antigravity\",\"decision\":\"PROCEED\"}\n","duration_seconds":3.159,"num_turns":1,"usage":{"input_tokens":6635,"output_tokens":97,"thinking_tokens":81,"total_tokens":6732}}`
  - Elapsed: 15.3s total wall clock. Status: `PASS`.
- **Turn 2 (Session Resume by ID):**
  - Prompt: `Do not use any tools. Return only the JSON object: {"judge":"turn_2","resumed":true}`
  - Flag: `--conversation d74ebd97-5503-43c5-b797-ee64f93bac70`
  - Output: Returned `num_turns: 2`, with tokens `input_tokens: 13591, output_tokens: 209, thinking_tokens: 181, total_tokens: 13800`.
  - Elapsed: 10.6s total wall clock. Status: `PASS`.
- **Permission Denial Diagnostic Verification:**
  - Prompt requested environment inspection requiring the `command` tool without `--dangerously-skip-permissions`.
  - Stderr: `"jetski: no output produced — a tool required the 'command' permission that headless mode cannot prompt for, so it was auto-denied."`
  - Exit Code: `0`
  - Status: `"SUCCESS"`
  - Response: `""` (empty)
  - Diagnostic Payload: `"denied_actions":[{"action":"command","display_name":"RunCommand"}]`
  - Classified as: `FAIL` (demonstrating that the adapter must inspect `denied_actions` to avoid false-positive success).

### 5.2 OpenAI Codex (`BLOCKED`)
- Reconciled against existing experiments:
  - Isolated home `account/read` returns no account (`BLOCKED`).
  - `turn/start` emits local `turn/started` followed by backend HTTP 401 Unauthorized.
  - Native queueing (`thread/queue/add`) is unavailable without unreleased `experimentalApi`.
  - Concurrent Turn B dropped after Turn A failed (POC-04).
  - Stale owner generations continue writing (POC-05 S2).
  - Status: `BLOCKED` pending official OAuth registration or dedicated profile bridge.

### 5.3 Anthropic Claude Code (`POLICY_BLOCKED`)
- Non-inference evaluation completed:
  - CLI v2.1.302 verified.
  - `claude auth status --json` confirms Claude Pro subscription.
  - Policy gate enforced: automated third-party orchestration prohibited under Claude subscription terms.
  - Fail-closed enforcement: 0 inference requests dispatched. Status: `POLICY_BLOCKED`.

---

## 6. Codex Existing PoC Reconciliation

| Reported Finding | Reconciled Root Cause | Architecture Impact |
| :--- | :--- | :--- |
| **HTTP 401 on Turn Start** | The isolated `CODEX_HOME` lacks auth tokens. App Server dispatches model requests without credentials. Default profile credentials cannot be extracted without violating SIWC preview terms. | A separate `CODEX_HOME` requires either interactive device sign-in into that profile or host-mediated custody. |
| **`turn/started` emitted before failure** | App Server emits `turn/started` on local queue entry. The network call to OpenAI occurs asynchronously afterwards. | `turn/started` is an admission milestone, not proof of model execution or valid entitlement. |
| **Turn B dropped when Turn A fails** | In default capability mode, App Server accepts Turn B during active Turn A but fails to start it after Turn A completes/fails. | Deszo cannot rely on the Codex App Server for queueing; the host-side worker queue must serialize requests. |
| **Stale owner can write (POC-05 S2)** | Codex has no owner-generation fencing; thread writer locks only protect live same-home processes. | Deszo trusted host must enforce generational fencing before dispatching commands. |
| **Native Queue needs `experimentalApi`** | `thread/queue/add` returns `-32600` unless `experimentalApi: true` is declared during `initialize`. | Adapter must default to host serialization; native queueing remains an unverified experimental path. |

---

## 7. ADR Amendments

[ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md) was amended with minimal normative changes:

1. **Context & Role Definition (Section Context):**
   - Clarified that the Judge is an external registered controller session independent of any single provider. Codex was the initial reference adapter; providers are integrated via verified capability adapters.
2. **Amendment P01: Multi-Provider Judge Adapters, Subscription Verification, and Non-Portability (Section 3):**
   - *Adapter Lifecycle Interface:* 12 logical operations (`inspectCapabilities`, `validateAuthentication`, `verifyBillingMode`, `registerSession`, `resumeSession`, `admitTurn`, `startTurn`, `observeTurn`, `submitDecision`, `interruptTurn`, `reconcileUncertainTurn`, `releaseSession`).
   - *Fail-Closed Subscription Policy:* `subscription_only` strictly forbids silent API-key fallback or automatic credit overages.
   - *Session Non-Portability:* Sessions are provider-specific; switching providers requires explicit re-registration, advancing the owner generation, and establishing a new evidence boundary. Unresolved requests remain durable.
   - *Headless Permission Diagnostics:* Requires inspection of `denied_actions` and payload completeness to catch auto-denied tools.
   - *Preservation of T01 & T02:* Strictly preserves bounded queue waiting (`queued_behind_active_turn`), fixed 900s deadline from `t0`, dedicated custody, owner fencing, and clone detection.
3. **Acceptance Criteria (Section 8):**
   - Updated `ADR7-11` for independent multi-provider adapter verification.
   - Added `ADR7-18` requiring real model execution under confirmed subscriptions, conversation resume across turns, exact token telemetry, diagnostic permission inspection, and fail-closed refusal of unapproved API key fallbacks.
   - ADR status remains `Proposed` pending user acceptance.

---

## 8. Technical Limitations

1. **CLI Multi-Writer Locking:** Neither Antigravity nor Claude Code CLI provides native inter-process file locks for conversation sessions. Central session stores (`~/.gemini/antigravity-cli/conversations/`) rely entirely on Deszo's host-level controller queue for single-writer serialization.
2. **Headless Tool Execution Permissions:** Antigravity auto-denies unapproved command tools in headless print mode. To invoke external tools (e.g. MCP read tools) without using `--dangerously-skip-permissions`, specific allow-rules must be pre-configured in `settings.json`.
3. **Usage Telemetry Variance:** Antigravity provides exact machine-readable token counts directly in its JSON output. Codex App Server stdio notifications omit token counts, requiring indirect estimation or server log inspection.

---

## 9. Architecture Consistency

The multi-provider Judge contract maintains strict consistency with the foundational ADRs:
- **ADR-0002 (Supervised Control & Audit):** Retains complete journal audit and monotonic user Stop precedence.
- **ADR-0004 (Context & Acceptance Contracts):** Compact evidence packages preserve immutable digests and complete coverage accounting without summarizing away critical details.
- **ADR-0006 (Application Lifecycle & Authority):** Trusted host enforces authority boundaries and owner-generation fencing; provider adapters run with restricted credentials under `DESZO_MANAGED_INVOCATION`.

---

## 10. Readiness Decision

| Dimension | Verdict | Summary |
| :--- | :--- | :--- |
| **Architecture Acceptance** | **READY** | ADR-0007 as amended provides a complete, robust, provider-independent controller abstraction. |
| **Implementation Readiness** | **READY FOR STAGE 1** | Contract schemas and adapter interfaces are clearly specified; Antigravity primitives are verified. |
| **Provider Enablement: Antigravity** | **ENABLE FOR STAGE 1** | Real model execution, session resume, and subscription billing verified live on version 1.4.4. |
| **Provider Enablement: Codex** | **DEFER TO STAGE 2** | Technical primitives verified; deferred pending official SIWC OAuth registration for isolated profiles. |
| **Provider Enablement: Claude Code** | **UNSUPPORTED / DISABLED** | Policy gate forbids automated orchestration under Claude Pro subscriptions; API key billing forbidden. |
| **Subscription Billing Verification** | **VERIFIED (Antigravity)** | Verified consumer Google account OAuth without GCP billing or credit consumption. |

---

## 11. Recommended Implementation Order

1. **Stage 1A — Formalize Contract Schemas:**
   Publish versioned schemas for attention requests, evidence packages, decision receipts, and provider capability declarations.
2. **Stage 1B — Implement Antigravity Judge Adapter:**
   Implement the production `AntigravityJudgeAdapter` in `runtime/core/` and integrate it with the ADR-0006 persistent worker queue. Configure scoped MCP allow-rules in `settings.json` to permit Judge evidence reads.
3. **Stage 1C — End-to-End Pilot Verification:**
   Execute the Fixer reference pilot using Google Antigravity as the external Judge, verifying real Developer/Watcher escalation, compact evidence delivery, and decision application without periodic polling.
4. **Stage 2 — OpenAI Codex SIWC Integration:**
   Implement registered OAuth client flow for Codex App Server to enable authorized ChatGPT subscription usage within isolated profiles.
