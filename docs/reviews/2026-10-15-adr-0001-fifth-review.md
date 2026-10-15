# ADR-0001 fifth review

Date: 2026-10-15  
Subject: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md), as amended after the [fourth review](2026-10-15-adr-0001-fourth-review.md)  
Verdict: **Ready for the user's acceptance decision.** Every finding from the four earlier reviews is resolved. The four items below are low-severity precision points for the Stage 1 contract package; none changes the architecture.

## Status of earlier findings

| Finding | Status |
| --- | --- |
| ADR4-01 scope matrix and script credentials | Resolved. Every v2 route has an explicit scope; I checked the table against the routes in [runner.mjs](../../runtime/runner.mjs) and none is missing. Recovery and Context chat are first-party only, with the reason stated. Under the launcher custody rule, scripts and tests hold their own isolated runners' first-party tokens and switch to the external token when exercising client authority |
| ADR4-02 development path | Resolved. The development editor stays external-only and runs fixtures through its launcher's startup confirmation-disabled policy. The option is dev/test only |
| ADR4-03 IPC exposure | Resolved. `get_runner_connection` returns the first-party token only after checking the window label and the exact bundled frontend origin and path. Debug and `web-isolated` builds get external scope only. "Never render untrusted HTML" is now a requirement and a release scenario |
| ADR4-04 confirmation-off response | Resolved. The request goes through the same pinned-snapshot checks and returns `outcome: "created"` with the run body, or the typed failure |
| ADR4-05 external Stop | Resolved by an explicit decision. External root and node Stop may target any run in the selected store, and this is listed as a release scenario |

## Remaining points for Stage 1

### ADR5-01 (low): the token-emission rule for a runner nobody captures

The custody rule says the runner emits the first-party token on stdout to its launcher, and that "stdout is captured rather than forwarded to a terminal or log". The runner cannot enforce the second half. Today it writes its connection line to stdout unconditionally, so a runner started by hand from a terminal would print the first-party token into terminal scrollback or a redirected log.

Specify the emission condition so that leak cannot happen. For example: emit the first-party token only with an explicit launcher option, or only when stdout is a pipe rather than a TTY. A runner started without that condition simply has no first-party holder: it is usable for external-scope work, and it can run fixtures only through the startup policy.

### ADR5-02 (low): base IPC eligibility on the bundled frontend, not the release build

`get_runner_connection` hands out first-party scope "in a release build". The property that matters is that the window shows the bundled frontend (the application-owned origin serving `frontendDist`), not the build profile. `tauri build --debug` also serves the bundled frontend, while `tauri dev` serves `devUrl`. With the rule keyed on the release profile, the approval queue, pending badge and Run → approve flow in the Deszo window can only be exercised in a full release build.

Keying eligibility on the bundled origin alone keeps the dev-server exclusion and gives Stage 4 and Stage 5 a debuggable build in which to verify the first-party UI.

### ADR5-03 (low): say how the fixture policy is kept out of packaged builds, and state the closed-app residual

The fixture policy is "unavailable in packaged builds", but packaged builds ship the same runner code through `runtime:bundle`. State the mechanism:

- the bundle step strips the option; or
- the runner refuses it unless the root is a designated fixture root, for example outside the installed application root.

Under the custody rule, any process that starts a runtime holds its first-party token. While Deszo is running, the runtime lock stops a same-account agent from starting a second runtime on the user's store. While Deszo is closed, nothing does. The ADR's same-account residual statement covers this case, and naming it there keeps the stated guarantee precise: the split protects against callers that hold only the connection-file token while the app owns the store.

### ADR5-04 (nit): the run-request ID is not "unguessable"

The scope table lets the external scope read request status "by its unguessable request ID". That ID is the client-chosen command `requestId`, so its unpredictability is up to the client. External scope can already list and read every run, so request status needs no secrecy anyway. Drop "unguessable", or say that request status carries no information beyond what external read scope already exposes.

## Recommendation

Accept ADR-0001 when the user is satisfied with the architecture, and record ADR5-01 to ADR5-04 as Stage 1 contract items. Acceptance does not authorize implementation; the ADR already requires a separate instruction for that.
