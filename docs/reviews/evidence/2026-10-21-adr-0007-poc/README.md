# ADR-0007 Codex PoC, 2026-10-21

Evidence for the bounded technical proof-of-concept required before ADR-0007 can be enabled. It tests the installed Codex App Server against the two ADR amendments: serialized Judge turns (T01) and dedicated-session single-writer ownership (T02). It is not the ADR-0007 implementation, does not accept the ADR, and authorizes no Judge turn, workflow revision or Deszo run.

Report: [ADR-0007 PoC report](../../2026-10-21-adr-0007-poc-report.md).

## What is and is not claimed

- Experiments run the real `codex app-server` binary over stdio JSON-RPC. Every turn-related result is App Server behaviour.
- An isolated `CODEX_HOME` is used for each run. The default profile (`C:\Users\jusse\.codex`) is not started, written or copied. Its session store was read only by file name (count and presence).
- The isolated homes have **no sign-in**. A turn is therefore admitted and emits `turn/started`, but the model request fails with HTTP 401 and Codex retries. Those requests carry no credential and are rejected at the provider edge. Nothing is billed, and no model answer was obtained. Consequently POC-03 (a real Judge wake-up with a model response and a scoped tool call) is **BLOCKED**.
- Timing values are measurements of the control path in this unauthenticated state, not of model turns.
- Controlled-clock boundary tests are labeled as such and are not live measurements.

## Environment (recorded by POC-01)

| Item | Value |
| --- | --- |
| OS | Windows 10.0.26300 (x86_64) |
| Node.js | v22.20.0 |
| Active Codex binary | `codex-cli 0.163.0-alpha.10.2`, `AppData\Local\OpenAI\Codex\bin\896a0166b774037a\codex.exe` (SHA-256 `f6dbf48c…`). Two of its `app-server` processes were running during the check. |
| Secondary launcher | `codex-cli 0.130.0-alpha.5`, `AppData\Local\OpenAI\Codex\bin\codex.exe` (SHA-256 `dd4adf30…`). Not the tested target. |
| Default profile | Signed in with ChatGPT. Not used by any experiment. |
| Isolated homes | `C:\DeszoPoC\adr7-poc-run\home-*`. Outside the repository and outside Windows Temp. A packaged desktop app redirects `AppData` writes for its children, which would relocate isolated homes; the run root avoids that. |

## Reproduction

Run from this folder. The runner writes sanitized JSON to `results/` and removes no user data. Homes are created under `C:/DeszoPoC/adr7-poc-run` (override with `DESZO_POC_ROOT`).

```bash
cd docs/reviews/evidence/2026-10-21-adr-0007-poc && node --test lib/judge-attention-timing.test.mjs
```

```bash
cd docs/reviews/evidence/2026-10-21-adr-0007-poc && node run-poc.mjs POC-01 POC-02 POC-05
```

```bash
cd docs/reviews/evidence/2026-10-21-adr-0007-poc && node run-poc.mjs POC-03 POC-04 POC-06 POC-08
```

The second group takes roughly 5 to 8 minutes. Run it in the background and wait for its summary.

To enable real Judge turns, the user (not automation) signs the isolated home in with the supported device flow. This is outside the PoC and needs the user's own account:

```bash
CODEX_HOME=C:/DeszoPoC/judge-poc-home "C:/Users/jusse/AppData/Local/OpenAI/Codex/bin/896a0166b774037a/codex.exe" login --device-auth
```

After sign-in, rerun POC-03 and the turn arms of POC-04 and POC-06. The results from an authenticated home are a separate evidence set and must not overwrite these.

## Files

- `lib/codex-app-server.mjs`: JSON-RPC client over stdio. Records monotonic times for requests and notifications. Declares capabilities only when asked.
- `lib/poc-echo-mcp.mjs`: harmless read-only MCP server that returns a fixed string. Used as the scoped tool.
- `lib/judge-attention-timing.mjs` and `.test.mjs`: controlled-clock model of the amended timing contract (T01) and its boundary tests.
- `lib/experiments-session.mjs`: POC-01 and POC-02.
- `lib/experiments-writer.mjs`: POC-05 single-writer experiments.
- `lib/experiments-turns.mjs`: POC-03 and POC-04 (three arms).
- `lib/experiments-takeover.mjs`: POC-06 takeover, fencing and ambiguous start.
- `lib/experiments-failures.mjs`: POC-08 failure matrix.
- `run-poc.mjs`: runner. Writes `results/<POC-id>.json` and a summary per invocation.
- `results/superseded/`: earlier runs of POC-04 and POC-06 that were found to contain a false pass and a missing check. Kept unchanged for the audit trail; they are not evidence.

## Sanitization

Results replace the user profile and the run root with `<USER_PROFILE>` and `<POC_ROOT>`. No sign-in material, token or auth file is read or copied. Session identifiers and marker strings are kept because they are needed to correlate results.
