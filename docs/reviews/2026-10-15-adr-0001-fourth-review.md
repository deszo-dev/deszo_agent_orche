# ADR-0001 fourth review

Date: 2026-10-15  
Subject: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md), as amended after the [third review](2026-10-15-adr-0001-third-review.md)  
Verdict: **Architecturally ready; two credential-custody details should be fixed in the ADR text before acceptance.** Every finding from the three earlier reviews is resolved. What remains is mostly about who holds the first-party token outside the packaged app, and which existing v2 commands each scope may call. The current wording forbids repository scripts and tests from holding a first-party token, yet they rely on commands that only that scope will allow.

## Status of earlier findings

| Finding | Status |
| --- | --- |
| ADR3-01 credential split | Resolved. The external token lives in the connection file; the first-party token goes only through the supervisor's stdout pipe and Tauri IPC. Authorization comes from the token alone, and the residual same-account risk is stated honestly |
| ADR3-02 shared 202 | Resolved. Both success shapes carry a required `outcome`, and the caller migration is listed |
| ADR3-03 approval semantics | Resolved. Approval re-checks the pinned snapshot, decision receipts and the run commit together, and expected failures are recorded as denials. A 30-minute absolute expiry survives restart, replayed pending receipts are intended, and the window queue is specified |
| ADR3-04 incarnation storage | Resolved. Incarnations are runtime-owned, assigned in the save transaction and migrated. The single-save remove/re-add case is documented and covered by fixtures |
| ADR3-05 Antigravity directory | Resolved. The handshake reports the canonical paths, and the check repeats on workspace creation or move |
| ADR2-04 receipt test | **Done in code.** `engine.test.mjs` "a failed run receipt write rolls back run records and skips post-commit dispatch" asserts rollback, no receipt and no dispatch |

## New findings

### ADR4-01 (medium): the scope matrix leaves existing v2 commands unassigned, and the rule for scripts and tests contradicts what they call

External scope is defined positively as "authoring, reads, run requests, and Stop". Several existing token-authenticated v2 commands are therefore implicitly first-party only, but the ADR never says so:

- `PUT /api/v2/workspaces/{id}`;
- `POST …/recovery`, whose retry re-dispatches provider invocations;
- Context chat `POST …/messages`, which captures and runs a provider invocation;
- Context acknowledgement;
- node Stop;
- Cache pin/freeze;
- `PUT /api/v2/settings`.

Excluding chat and recovery is correct, and it should be explicit: either one would otherwise be a provider invocation outside the confirmation path. But the same rule collides with the ADR's statement that repository scripts and tests "do not receive first-party credentials":

- [pilot.mjs](../../scripts/pilot.mjs), [smoke.mjs](../../scripts/smoke.mjs) and the test helper [helpers.mjs](../../runtime/tests/helpers.mjs) create their workspace with `PUT /api/v2/workspaces/…`.
- The helper also calls `…/recovery`.
- Six call sites in `runtime/tests/*.test.mjs` use recovery, chat or settings.

A confirmation-disabled fixture policy covers run requests only. These calls would all fail.

Recommendation:

- Enumerate the full v2 matrix in Stage 1. For each endpoint, list the scope it requires, and mark which calls dispatch providers.
- Replace the "no first-party credential" rule for repository tooling with a custody rule: **the process that launches a runtime receives its first-party token on that runtime's stdout.** The Tauri supervisor is that process for the packaged app. A script or test that starts its own isolated runner is that process for the runner it starts. The token still never reaches the connection file, so a bridge or other process that merely reads the descriptor stays external.
- Keep the confirmation-disabled fixture only where a test deliberately exercises the external request path.

### ADR4-02 (medium): standalone and development runtimes have no path to Run or approve

The development launch configurations start a runner without the Tauri supervisor (`fixture-runtime-isolated`), plus a browser editor (`web-isolated`). The user may also run `runtime/runner.mjs` directly. The ADR gives `web-isolated` external scope only. With confirmation on by default, that browser editor can no longer press Run or approve a request. Nothing else can approve either, because approval requires first-party scope and turning confirmation off requires it as well. Development and manual testing of the Run, approval and queue UI is therefore blocked.

Recommendation: under the ADR4-01 custody rule, the launcher of a standalone runner holds its first-party token. Then specify how a development editor may receive it, for example:

- an explicit dev-only launch option that writes the token to a file named by the developer, outside `connection.json` and the application root; or
- a documented choice that standalone runners start with the confirmation-disabled fixture policy and the dev editor never approves.

Either way, packaged builds must not contain the dev mechanism.

### ADR4-03 (low): the IPC command should be limited to the bundled frontend

`get_runner_connection` will return the first-party token to whatever page the `main` window has loaded. Release builds load the bundled `frontendDist`. Debug builds load `devUrl` `http://127.0.0.1:1420`, and the token goes to any server on that port. This machine already runs a Vite server on 1420 that may not be Deszo's. The current capability ([default.json](../../src-tauri/capabilities/default.json)) scopes by window, not by origin.

Recommendation:

- Restrict the command to the app's own origin in release builds.
- In debug builds, return only the external token unless the dev mechanism from ADR4-02 is enabled.
- Keep the existing property that the Result Viewer never renders untrusted HTML (no `dangerouslySetInnerHTML` or iframes today), and state it as a requirement, since a script injected into the webview would inherit first-party authority.

### ADR4-04 (low): the response when confirmation is disabled is unspecified

With confirmation disabled, an external request "may be automatically approved by that saved policy", but the ADR does not say which `outcome` `start_run` returns. Scripts that use the confirmation-disabled fixture need to know whether to read `run.runId` immediately or poll `get_run_request`.

Recommendation: automatic approval runs the same approval checks in the request's own transaction and returns `outcome: "created"` with the run body and the request ID. A failed check returns the typed denial directly, and `get_run_request` reports `approved` or `denied` consistently.

### ADR4-05 (low): external Stop reaches first-party runs

External scope includes Stop for any run. A client with `--allow-execution` that has been misled by untrusted output can therefore cancel the user's own long-running first-party runs. That is less harmful than starting runs, but it is irreversible for in-progress Full Access work.

Recommendation: either restrict external Stop to runs that originated from external requests, or state explicitly that external clients may stop any run and list this in the release scenarios.

## Recommended path

Write the ADR4-01 custody rule and the ADR4-02 development path into the ADR, since both change the credential model. ADR4-03 to ADR4-05 can be settled in the Stage 1 contract package. With ADR4-01 and ADR4-02 amended, I see no remaining blocker to the user's acceptance decision.
