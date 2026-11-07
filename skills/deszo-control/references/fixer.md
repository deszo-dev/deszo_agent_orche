# User's Fixer workflow

Use the saved `deszo-fixer` workflow as the authority for current assignments. These are the user's selected roles, not fallback model defaults:

| Role | Provider/model | Explicit effort |
| --- | --- | --- |
| External Judge | This Codex chat, GPT 6.1 Sol | max |
| Watcher | Antigravity, gemini-3.8-flash-high | high |
| Developer | Claude Code, claude-haiku-5-5 | xhigh |

The Judge is not an Agent node. The user authorized ADR 3–6 implementation through this workflow. A later explicit request to repair or audit Deszo directly can authorize a scoped exception; record that scope rather than treating it as permission to change future assignments.

One bounded task goes to Developer. Watcher evaluates its report: a routine CONTINUE gives concrete remaining work internally; a difficult or disputed issue escalates to the external Judge. The Judge supplies a decision, checks the resulting handoff and involves the user only for an actual human dependency or scope decision.

Preserve the saved graph and limits (currently three iterations, 45 active minutes, Developer 600 seconds, Watcher 300 seconds). Confirm the actual saved values before dispatch. Do not silently adjust models, efforts, review requirements or timeouts to make a run succeed.

Start from the existing preflight report and assign the next bounded engineering task. Its canceled run is not an accepted handoff. Avoid repeated repository-wide discovery and long copied logs. Use a short result with exact changed paths, check outcomes and evidence references. Investigate full provider output on escalation or a concrete defect.

`READY_FOR_REVIEW` is a workflow handoff, not final ADR acceptance. Independent code/test review, business acceptance, native UI checks, verified feature-branch delivery and any trusted-host evidence remain required where their ADR contracts say so. Do not push, merge or release without the user's authorization.
