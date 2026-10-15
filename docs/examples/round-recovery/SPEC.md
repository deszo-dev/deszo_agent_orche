# Round Recovery Specification

Example revision: 2  
Status: illustrative normative bundle for the test pipeline  
Language: English

This describes a hypothetical Node service, not changes to the existing Tauri prototype. The base service and test harness must be prepared later; this bundle supplies documentation only.

Capture this file, [spec-index.json](spec-index.json), and [implementation-map.json](implementation-map.json) together. The typed index declares normative/public/internal sections, dependencies, and executable check settings. Headings use exact `## ID` syntax. The final revision-3 section is explicitly informative.

## BUSINESS-TASK

A client that reconnects can inspect and resume its own paused round through the public API without creating a duplicate round or receiving a different recovery token.

## REQ-AUTH

Both round endpoints require a bearer token. Missing, malformed, unknown, and expired tokens return HTTP 401 with `{"error":"unauthorized"}`. A valid token identifies one user.

Use an injected integer clock in milliseconds. A token is expired when `expiresAt <= now`. Tests never wait for real time. Token authentication does not inspect round ownership or state.

## REQ-OWNERSHIP

After successful authentication and lookup of an existing round, both endpoints verify that the authenticated user owns it. A different owner returns HTTP 403 with `{"error":"forbidden"}` and reveals no round status or recovery token. Ownership checks belong to the round implementation and recovery test suite.

## REQ-RESUME

`GET /rounds/{roundId}` returns HTTP 200 with `{"roundId":"...","status":"paused|active|completed|expired"}` for an existing round owned by the authenticated user.

`POST /rounds/{roundId}/resume` changes paused to active and returns HTTP 200 with `{"roundId":"...","status":"active","resumeToken":"..."}`.

Repeating an active-round recovery returns the same round ID/token. It creates no new round or token. Transition/token allocation is atomic within the service instance, including concurrent duplicate requests. Persistence across a server restart is outside this example.

## REQ-ERRORS

Unknown round: HTTP 404 with `{"error":"round_not_found"}`. Resuming a completed/expired round: HTTP 409 with `{"error":"round_not_resumable"}`.

Authenticate → look up → verify ownership → validate recovery state. Failed authentication reveals no round existence; failed ownership reveals no status. GET may inspect an owned completed/expired round; its 409 restriction applies to POST resume.

## CONTRACT-AUTH

`src/auth.mjs` exports `authenticate(token, now, tokenStore)`, returning `{ userId }` for valid credentials or throwing `statusCode: 401` / `code: "unauthorized"`. It implements REQ-AUTH and does not inspect/mutate rounds.

The base provides token fixtures and a stable HTTP adapter. Tests include `expiresAt === now`: authentication must reject it.

## CONTRACT-RESUME

`src/resume.mjs` exports `getRound(roundId, userId, roundStore)` and `resumeRound(roundId, userId, roundStore, createToken)`. They implement REQ-OWNERSHIP, REQ-RESUME, and REQ-ERRORS, returning objects or throwing the documented errors.

The base `src/api.mjs` invokes CONTRACT-AUTH before CONTRACT-RESUME. Its adapter, token fixtures, exports, round store, injected clock/token factory, and harness must be verified when preparing the future toy project. Resume tasks receive the authentication contract too, because public error precedence depends on it.

## CHECK-AUTH-SYNTAX

Run `node --check tests/auth.test.mjs` on the captured test task result. Required exit 0, timeout 30 seconds. This catches syntax failure before accepting the test task; it proves no functional correctness.

## CHECK-RESUME-SYNTAX

Run `node --check tests/resume.test.mjs` on the captured test task result. Required exit 0, timeout 30 seconds. Functional checks remain integration criteria.

## CHECK-AUTH

Run `node --test tests/auth.test.mjs` on a disposable copy of the selected candidate. Required exit 0, timeout 120 seconds. Cover missing/malformed/unknown tokens, expiration immediately before/at/after the boundary, and valid credentials. Ownership cases belong to CHECK-RESUME.

## CHECK-RESUME

Run `node --test tests/resume.test.mjs` on the same candidate. Required exit 0, timeout 120 seconds. Cover GET inspection, first resume, sequential/concurrent duplicates, unknown/completed/expired rounds, wrong owner, and authentication-first error precedence.

The index owns the machine-readable commands. Resolve/pin the actual Node executable/version at execution; reports link that environment and candidate. Every command runs without network-dependent fixtures or live timing.

## ACCEPTANCE-SCENARIOS

1. Inspect the client's paused round after reconnecting.
2. Resume to an active round with a stable recovery token.
3. Preserve the round/token across repeated and concurrent requests.
4. Return the specified authentication/ownership errors without leaking round details.
5. Return documented unavailable/non-resumable errors.

Customer sees BUSINESS-TASK, public REQ sections, these scenarios, observed public responses, and engine check summaries. The materialized view excludes internal CONTRACT/CHECK/map sections and source. All review decisions still anchor to the same bundle/candidate IDs; supplied-view restriction is not an OS/provider-memory isolation guarantee.

## IMPLEMENTATION-MAP

[implementation-map.json](implementation-map.json) is the normative task plan. Workflow bindings select Claude implementer, Antigravity test-author, Codex reviewer, and an engine utility verification template.

Four source tasks are potentially independent under the approved contracts. Test tasks require review plus cheap syntax checks. TASK-VERIFY waits for all four accepted results, derives an engine-owned candidate, and runs both integration suites. A failed suite triggers internal Map triage/targeted repair; Map completes only when verification is accepted.

## EXAMPLE-REVISION-3

Informative only: a later revision may add Boolean `resumable` to GET, true for paused/active rounds. It affects recovery contracts/code/tests and verification; authentication's requirement/contract can remain unchanged.

M5 conservatively re-reviews and rebuilds for any changed specification. Only M6 may carry independent authentication approvals/results after proving their scope/input fingerprints unchanged.
