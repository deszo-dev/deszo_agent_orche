# Real-provider acceptance after RERUN-04

Date: 2026-10-14  
Previous evidence: [pilot rerun](2026-10-14-pilot-rerun.md), [RERUN-04 resolution](2026-10-14-pilot-rerun-resolution.md)

**Verdict: passed for the bounded reference pilot, with an operator recovery.** The fourth production run reached technical approval and final Customer acceptance. Its exported candidate passes all 28 generated tests and 21 independent business checks. All 349 local tests pass. The validation series also found and corrected Map Context recovery, ambiguous triage identity and incomplete pilot author validation; earlier failed/canceled runs remain in the evidence.

The successful run required one controller restart of the Specification Loop after the prepared author validator was corrected. It is not evidence of an unattended run or of arbitrary large-project reliability.

## Preflight

- Both RERUN-04 tests passed: imported-issue authorization boundaries and the complete Map revision → resolved issue → Gate OPEN → delivery acceptance fixture path.
- Re-evaluating the old recorded decisions no longer throws. Readiness/testability may close the Map issue; the public Customer cannot close its internal-contract issue. The original Claude blocker correctly leaves the actual recorded decisions at REVISION_REQUIRED.
- The documentation check passed after the role clarification: 15 schemas, 141 positive / 82 negative schema cases, 42 negative semantic cases, no errors.
- All three reference Delivery Loop fixture tests passed after the clarification.

These checks use no model quota. The historical stores and their original evidence remain intact.

## Live attempt before the role clarification

Root: `.deszo/pilots/after-rerun04`  
Run: `46f64709-6863-4682-ade6-fd7b3be83161`

All live documentation reviewers approved the initial bundle, and the implementation tasks ran. The authentication test review first found genuinely missing POST authorization cases. After those were added, the next two reviews rejected the isolated test snapshot because it lacked the implementation modules needed by `node --test tests/auth.test.mjs`.

That full check is defined with `source: candidate` and belongs to verification after assembly. The task snapshot contains only the base, declared dependencies and its own captured result. It deliberately lacks unrelated parallel tasks' outputs. The test writer could not satisfy this misplaced request by changing only its declared test file, and the Map paused at `task_attempt_limit`. Every CLI invocation completed successfully; this was a review-stage problem, not an output-contract or Gate-resolution crash. The controller closed the paused run as failed, preserving its evidence.

This attempt made 16 live invocations (8 Codex, 3 Claude, 5 Antigravity), lasted 1,452.404 seconds including the observation period, and ended with 1,178 journal events.

## Clarification

The task reviewer instructions in the [reference](../examples/reference-delivery/workflow.json), [M5](../examples/m5-delivery/workflow.json) and [M6](../examples/m6-selective-delivery/workflow.json) examples now explicitly distinguish task-source review from full-candidate verification. Test-source review evaluates required case coverage and the documented interfaces; missing declared inputs and genuine source defects still block acceptance. The engine still runs every approved full-candidate check after assembly.

The existing [M5 contract](../M5_CONTRACTS.md) now states this boundary directly. No engine acceptance rule, check command, provider adapter, timeout or issue-resolution permission was changed. The changed role instructions are part of the workflow/Map fingerprints, so they cannot silently reuse approvals under the previous instruction text.

## Second live attempt

Root: `.deszo/pilots/after-rerun04-stage`  
Run: `b3b50656-ef41-47d1-bb7a-7a4fc3e98964`  
Models: Codex `gpt-6-luna`, Claude `haiku`, Antigravity `gemini-3.8-flash-low`  
Adapters: production; no fixture answers or diagnostic schema fallback  
Wall bound: 35 minutes; workflow iteration and per-call bounds remain in force

The three specification reviewers approved `SPEC-59A9AECC7D52`, producing `CERT-EFC19A612998`. The next Codex task-review call reported a subscription usage limit. The runtime drained the healthy parallel calls and entered `waiting_for_user`; the harness canceled the run at its 35-minute wall bound. It ended as `canceled` after 2,102.659 seconds, with 807 journal events and 8 live invocations. It produced no final delivery certificate. The usage-limit event is an operational failure, not a source rejection or evidence of a Gate defect.

The [read-only evidence summary](evidence/2026-10-14-after-rerun04-summary.json) preserves all attempts, their provider invocations, Gate results, journal lifecycle and SQLite integrity results.

## Third live attempt after the subscription reset

Root: `.deszo/pilots/after-rerun04-quota-reset`  
Run: `50da9ba7-0a81-4f92-859a-a5e28bc62fba`  
Models and adapters: the same three production providers and models  
Wall bound: 60 minutes; workflow iteration and per-call bounds remain in force

Before dispatch, the account's read-only usage API reported that ordinary use was allowed again, with 5% of the five-hour window used and 51% of the weekly window used. No credits were purchased, account changed or model substituted.

Claude's first readiness invocation reported a transient OAuth refresh conflict before any inference (zero input/output tokens). The controller retried that stateless node through the documented recovery API with the same captured inputs. The retry succeeded, the remaining review ran, and the specification Gate opened for `SPEC-063C61F00958` with `CERT-7A118BB8F878`. No other process, credential or account was changed.

The first `TASK-RESUME-CODE` invocation also created `src/auth.mjs`, outside its sole write scope `src/resume.mjs`. Capture rejected the result with `output_contract`, drained the running peers and held the run for recovery. After inspecting the recorded result, the controller explicitly acknowledged that task conversation and retried the failed step. The repeated invocation produced a captured result within its declared scope. The rejected invocation was not selected or accepted. These are operator recovery actions, so this attempt must not be described as an unattended run.

Live source reviews also caught a permissive Bearer separator and missing concurrent duplicate-recovery test coverage. The normal Map repair path requested scoped changes; this did not require changing an approval or bypassing a check.

All four source tasks were accepted and the candidate was assembled. The complete suites then failed: the selected authentication module parsed a Bearer prefix twice and used object indexing on the prepared adapter's Map. Valid requests consequently returned 401. That failed verification correctly prevented delivery acceptance.

The shared Analyst twice returned `subjectId: TASK-VERIFY` for the triage of `SPEC-063C61F00958`. Both live decisions were rejected. The combined recovery request with `binding: acknowledge` was accepted, but selected no binding for the visible `analyst-history` Context; the next attempt failed before a CLI call because the actual binding was still `needs_review`. Separate Context acknowledgement worked, but did not repair the repeated identity mistake. The controller closed the run as failed. It lasted 1,093.392 seconds, with 1,266 journal events and 20 live invocations. No delivery was accepted.

## Runtime corrections after the third attempt

**AFTER-RERUN-01 — Map recovery targeted the wrong conversation.** The previous implementation searched by a task-prefix and selected the first role; it missed visible Contexts and ignored `fresh`. Recovery now resolves the same role, Context and epoch as dispatch. `acknowledge` applies to that exact binding, `fresh` creates and journals an actual remap for a New binding, and `keep` refuses an unusable binding before planning. Utility steps refuse binding options. The [M5 contracts](../M5_CONTRACTS.md) record this behavior.

**AFTER-RERUN-02 — Triage identity was left ambiguous to the provider.** The full runtime already rejected a wrong ID; the schema handed to the model had no exact subject constraint. The triage provider schema and full contract now pin the approved specification ID, and the prompt explicitly states the value to return. The semantic check remains in place. Nothing rewrites an agent's decision after it returns.

Four new end-to-end fixture regressions in [map.test.mjs](../../runtime/tests/map.test.mjs) pass: native subject identity, retry of a shared Analyst Context through repair, retry of the reviewer's own Context while preserving the writer's, and a real fresh-conversation remap retaining the old binding. The complete suite passes (348/348, 219.061 seconds), the documentation check passes (15 schemas, 141 positive / 82 negative schema cases, 42 negative semantic cases), and the runtime bundle builds. Before these changes, all 67 tracked runtime, shared, frontend, native and schema files matched the preflight baseline. The runtime changes are limited to [mapRuntime.mjs](../../runtime/core/mapRuntime.mjs) and [map.mjs](../../runtime/core/map.mjs); the remaining source changes are the fixture CLI and its Map tests.

## Fourth live attempt with the runtime corrections

Root: `.deszo/pilots/after-rerun04-recovery-fix`  
Run: `84ad4815-6772-4e22-9ca6-519a08ce1b6f`  
Models and adapters: the same three production providers and models  
Wall bound: 60 minutes; workflow iteration and per-call bounds remain in force

The first draft reached Gate prepare with an `ACCEPTANCE-SCENARIOS` heading omitted from the section index. The Gate correctly rejected it. **AFTER-RERUN-03 — the prepared pilot author validator was incomplete:** it checked indexed headings existed but did not reject unindexed headings. The read-only helper now uses the Gate's section parser and checks both directions, including duplicate headings and fenced examples. Its [regression](../../runtime/tests/pilot.test.mjs) passes, and the corrected helper rejected the actual saved draft with the same missing-index cause. The controller updated only the excluded `.pilot-validate.mjs` tooling and restarted the current Specification Loop iteration through the API. It did not rewrite the author's documents or an engine record. Future pilots install the same helper through [pilot-documents.mjs](../../scripts/pilot-documents.mjs).

The restarted author invocation corrected the bundle. All three live specification reviews accepted `SPEC-8D71A9ED325A`, producing `CERT-3CD0542ED71D`. The two implementation tasks and authentication test task were accepted on their first attempts. The recovery test review caught missing invalid-credential coverage; Antigravity repaired only that test task, and its second result was accepted. Both complete candidate checks then passed: 17 authentication tests and 11 recovery tests. The two technical reviews and final Customer review approved the same delivery. No approval, issue decision or check report was rewritten by the controller.

The run completed as `succeeded` after 930.118 seconds (15.50 minutes), with 1,222 journal events and 18 live invocations: 11 Codex, 3 Claude and 4 Antigravity. The 60-minute wall bound, normal iteration limits and 600-second call timeouts were not raised.

## Acceptance and exported delivery

| Evidence | Recorded value |
| --- | --- |
| Approved specification | `SPEC-8D71A9ED325A`, certificate `CERT-3CD0542ED71D` |
| Completed Map state | `MST-8E5851DD0B53`, all 5 tasks accepted |
| Selected assembled candidate | `CAND-B3F9524F841C` |
| Delivery subject | `DLV-4CC8D0437B2A` |
| Technical approval | `CERT-C2C16C52348C` |
| Final Customer acceptance | `CERT-52DB265D719B`, with both prerequisite certificates pinned |
| Required engine checks | 4 selected passing CheckReports: two task-source syntax checks and two full-candidate suites; all report intact source integrity |
| Independent exported-code probe | [21/21 passed](evidence/2026-10-14-after-rerun04-acceptance.json) |
| Repeated exported candidate tests | 28/28 passed, 0 failed |
| Record/export audit | [Passed](evidence/2026-10-14-after-rerun04-delivery-audit.json): certificate subject hashes agree, selected task results and their criterion records match the Map state, candidate sources match its selected dependencies, approved check commands and sources agree, and all 14 exported entries match their immutable artifact bytes |

The delivery subject digest is `4cc8d0437b2a137f2bdeef45c33c3bdf23eea4d76df5b3d4f39986864189c166`. The exported project and its specification/check evidence are in `.deszo/pilots/after-rerun04-recovery-fix/evidence/accepted-delivery/`.

The independent probe covers invalid credentials, the exact token-expiration boundary, ownership, missing rounds, forbidden terminal-state recovery, error precedence and repeated/concurrent token idempotence. It ran after export, using [pilot-acceptance.mjs](../../scripts/pilot-acceptance.mjs), without altering the candidate.

## Final checks and practical assessment

- Full local suite: 349/349 passed, 0 failed (224.836 seconds), including the five new regressions.
- Documentation/schema validation: passed; runtime bundle, frontend and default release executable builds: passed.
- [Final consistency checks](evidence/2026-10-14-after-rerun04-final-checks.json): all four pilot databases pass SQLite integrity checks, and their final loop Replay projections match the database lifecycle. No production runtime/schema/frontend/native source changed during the successful run, and no provider attempt remained active after it closed.
- This validation series used 62 real CLI invocations across its four preserved roots (32 Codex, 15 Claude, 15 Antigravity). No fixture answer or diagnostic provider fallback participated in the live runs.

The reference pipeline can now produce an accepted, independently checked delivery with the three selected subscription providers. Real review feedback caused a scoped test repair while healthy selections remained accepted. The safeguards refused wrong identities, out-of-scope writes, malformed documentation and failed candidate checks instead of granting acceptance. Explicit recovery worked, but the sequence exposed how much prompt accuracy and validation tooling matter with the simplest models.

The successful fourth run did not need a Map-origin specification revision or cross-revision approval/task carry. RERUN-04 is covered by its end-to-end fixture and read-only re-evaluation of the old real decisions; M6 revision/carry branches remain fixture evidence. The new Map recovery behavior is covered by its end-to-end fixture regressions, not a second live occurrence of the exact failed recovery path. Those distinctions prevent treating one small successful delivery as coverage of every branch.

## Scope

Installed-app startup/crash recovery, the original-journal Replay and the 30-minute fixture soak were already validated in the previous pilot. They were not repeated here. The default release executable was rebuilt with the Node runtime corrections; installing that new build and repeating packaged-process crash tests were not part of this follow-up. Large projects, multi-day load and clean-machine installation remain outside the pilot's demonstrated scope.
