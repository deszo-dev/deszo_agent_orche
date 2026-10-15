# Second Review of Documentation v0.6

Reviewed: 2026-10-13
Scope: all files under `docs/` after the v0.6 rewrite: 14 topic documents, 9 schemas, the M1 SQL, both example bundles, and the [resolution record](2026-10-13-review-resolution.md). Checked against the prototype in `runtime/`, `src/`, and `src-tauri/`.
Previous review: [2026-10-13-pre-implementation-review.md](2026-10-13-pre-implementation-review.md)

**Verdict: M1 is close to implementable.** After the six M1 corrections in §2 (one pipeline-flow decision and five small schema/API additions), the M1 package is complete enough to code against. M2–M6 still list their own missing schemas as prerequisites, which is the right way to handle them. §3 records four design defects in the later-milestone wiring and the example map, so they are fixed before those contracts are written.

---

## 1. Status of the previous findings

I checked every claimed resolution against the documents themselves, not against the resolution table.

| Finding | Status | Notes |
| --- | --- | --- |
| B1 scope | Resolved | M1–M6 each have exit evidence; the first user release is M2 (keeps D13). |
| B2 schemas | Resolved for M1 | Workflow, value, attempt, journal, and API schemas plus the DDL exist. Later packages are listed in MILESTONES as blocking prerequisites. |
| B3 loop carry | Resolved | Typed `specificationState`/`deliveryState`, record Merge, Condition, and port-level wiring tables. One new defect in that wiring is described in §3.1. |
| B4 selective review | Resolved by deferral | M4/M5 re-review everything; the M6 design uses explicit per-role Routes. |
| B5 limits | Resolved | Active time is the union of running intervals and excludes capacity/lock waits; backstops were raised. |
| B6 example deps | Resolved, with a regression | REQ-OWNERSHIP is split out, resume tasks carry the auth closure, and the §7.4 defect is now plausible (`<` instead of `<=` returns 200). Moving cases into the CHECK sections created a new gap, described in §3.2. |
| B7 store reachability | Resolved as far as claimed | Sibling `workdirs/` and verify-on-read. The limit against a same-user attacker is stated honestly. |
| S1–S8 | Resolved | Typed section index, `type: candidate`, syntax checks on test tasks, explicit Customer view selector, pinned templates. |
| D1 duplication | Resolved | One normative home per topic, a precedence rule, and BASELINE/OPEN_QUESTIONS reduced to indexes. The docs shrank from about 215 KB to about 140 KB. |
| D2 transitions | Resolved | Transition tables for run, attempt, Context, Gate, map, and task. |
| D3 approval | Resolved | MILESTONES names the M1 baseline; an explicit "implement M1" request counts as authorization. |

I also validated independently with Python `jsonschema` 4.26 (Draft 2020-12):
- All 9 schemas compile.
- `m1-context-chain/workflow.json`, `implementation-map.json`, `spec-index.json`, and the `deliveryState` example in TEST_PIPELINE all validate.
- The section-index dependency graph is acyclic.
- Every resume task's normative closure is covered by its inputs.

## 2. M1 issues — fix before coding M1

### M1-1. A failure kills healthy sibling calls

The run transition table (M1_CONTRACTS) and RUN_HISTORY say that when an attempt fails, the engine should "stop scheduling and terminate active siblings". In a parallel graph, one Claude authentication error would then kill a Codex call that is half done. That call's quota is wasted, and its Context goes to `needs_review` for no reason. This conflicts with the documents' own goal of not damaging native sessions.

**Change:** On failure, stop *dispatching* new work, let attempts already running finish and commit, then move to `failed`. If an immediate abort is ever wanted, the user can still use root Stop.

### M1-2. Concurrency limits are per workflow but described as global

`globalLimit` and `providerLimits` live in the workflow's `settings` (`workflow.schema.json`), but the scheduler table describes them as application-wide capacity. Two workspaces may run at the same time, and each workflow would enforce its own "global" limit of 3, giving 6 calls together. Subscription rate limits are per account, not per workflow.

**Change:** Move capacity to application settings. Let a workflow only *lower* its share, or drop the per-workflow fields from core-v1 entirely.

### M1-3. Every log chunk costs a file, an fsync, and a full SQLite transaction

STORAGE requires every journal envelope and every `attempt.log_chunk` to be an immutable object: stage, flush, hash, rename, then a `synchronous = FULL` transaction, then verification on read. CLIs stream hundreds to thousands of JSON lines per attempt. That means thousands of small files and fsyncs per run, and Replay re-hashes each one.

**Change:** Batch log chunks by size or time (for example 64 KB or 250 ms), and/or store small envelopes inline in SQLite with a digest column. Reserve object files for prompts, outputs, and large evidence. State the batching rule in the journal contract so that the chunk boundaries a Replay step shows are deterministic.

### M1-4. The API cannot list anything

The M1 endpoints only work if the caller already knows a `runId` or `workflowId`. There is no `GET /runs`, `GET /workflows`, or `GET /workspaces`. That rules out:
- the history panel that D12 requires;
- the PRODUCT_SPEC history view;
- finding interrupted runs after a restart.

**Change:** Add cursor-paginated list endpoints:
- `GET /api/v1/runs?workspaceId=&state=&cursor=`
- `GET /api/v1/workflows`
- `GET /api/v1/workspaces`

### M1-5. Context bindings are missing run/node scoping in the DDL

The `new` mode creates "one fresh run-scoped binding … reused within that run". However, `context_bindings` has no `run_id`, `workflow_id`, `context_node_id`, or `mode`. The engine could find the binding for Context node X in run R only by searching through attempts. There are also format mismatches:
- The workflow schema's `bindingId` is `minLength: 1`.
- The API and journal use UUIDs for the same field.

**Change:**
- Add `mode`, `workflow_id`, `context_node_id`, and a nullable `run_id` (null for `continue` bindings).
- Make `bindingId` a UUID everywhere.

### M1-6. Smaller M1 contract gaps

- **Which hash does `createRun.workflowSha256` pin?** M1_CONTRACTS defines an execution hash (JCS, excluding `view`), a snapshot hash (exact bytes), and a "structural digest" returned by `savedWorkflow`. Name one of them explicitly.
- **Job Object ownership.** M1 requires child process trees to be contained "across runtime loss (for example, a Windows Job Object)". Node.js has no native Job Object API.
  - Specify that the Rust supervisor puts the runtime in a job with `KILL_ON_JOB_CLOSE`, so children inherit the job.
  - This makes the "explicitly adopt surviving processes" path dead code in Tauri mode, so say so.
  - Also say what the browser-dev runner (`npm run runner`, which has no Tauri) does instead.
- **Blocked nodes without an attempt.** `blocked` exists only as an *attempt* state, and `node.planned` carries no state. Either specify that every planned node gets an attempt in `scheduled` at plan time, which makes `scheduled → blocked` expressible, or add a `node.state_changed` event.
- **Model pattern rejects valid Claude aliases.** `^[A-Za-z0-9][A-Za-z0-9._:/-]*$` rejects `opus[1m]`-style aliases that Claude Code accepts; I confirmed this by validation. Allow `[` and `]`, or document the exclusion.
- **Duplicate slots pass the schema.** `slots` uses `uniqueItems` on objects, so `{id:"a"}` and `{id:"a",description:"x"}` both pass (confirmed). Add "slot IDs are unique" to the semantic validation list.
- **`maximumAgentTimeoutSeconds: const 600`** is fine for M1. However, real M5 implementer tasks routinely take longer than 10 minutes, and changing a `const` later is a breaking change in the capabilities contract. Make it a plain integer now.
- **Capabilities provider uniqueness.** "One record per provider, unique" is not enforced by the schema. That is acceptable as a semantic rule, but list it as one.

## 3. Later-milestone design defects — fix before writing those contracts

### 3.1 A selected Merge with zero active inputs blocks the success path (M4)

PIPELINE_EXECUTION: a selected Merge "commits only when exactly one input succeeded and all other alternatives are proven inactive". In the Delivery wiring, `D.failure-join` joins the REVISION_REQUIRED branches of the technical and final Routes. On the **happy path**, both Routes choose OPEN, so `D.failure-join` has *zero* active inputs. As specified, it can neither commit nor be skipped, and the accepted delivery would hang. The same situation happens to the conflict/failed-check join inside TASK-VERIFY whenever checks pass.

**Change:** Specify that when every alternative is proven inactive, the selected Merge's output is Inactive and is skipped downstream. Add a fixture for this case to the M4 exit evidence.

### 3.2 Test-author tasks never receive their check definitions (example map)

The required test cases are written in CHECK-AUTH and CHECK-RESUME. The review response moved the ownership and error-precedence cases into CHECK-RESUME. But:

| Task | Writes | Receives | Missing |
| --- | --- | --- | --- |
| TASK-AUTH-TESTS | `tests/auth.test.mjs` | REQ-AUTH, CONTRACT-AUTH, CHECK-AUTH-SYNTAX | **CHECK-AUTH** |
| TASK-RESUME-TESTS | `tests/resume.test.mjs` | auth/ownership/resume/errors closure, CHECK-RESUME-SYNTAX | **CHECK-RESUME** |

The closure rule doesn't catch this, because the functional checks are criteria of TASK-VERIFY, not of the test tasks. Two consequences:
1. The test author is never told which cases the suite must cover.
2. At M6, a changed case list in CHECK-* would not change the test task's fingerprint, so the old tests would be *carried forward* incorrectly.

**Change:**
- Add `spec:CHECK-AUTH` / `spec:CHECK-RESUME` to the test tasks' inputs and readScopes.
- Add a mechanical validator rule: *a task whose output paths appear in a check command's arguments must include that check in its normative closure.*

### 3.3 The repair cycle inside the Map has no bound (M5, R09)

When TASK-VERIFY fails, triage runs inside the Map, a target task is repaired, and verification runs again. Each task's repair scope is limited to 3, but the verify → repair → verify cycle can target a *different* task each time. Only the Delivery Loop's 360-minute backstop bounds it. R09 requires bounded loops, and none of the documents names the scope that owns this counter.

**Change:** Add a Map-level verification-cycle limit, for example 3 failed verifications per map generation, that pauses the Map. Journal it like the other limits.

### 3.4 The "verification" role description contradicts its wiring

The TEST_PIPELINE role table says `verification` is an "engine utility template … no model/session". Its wiring then contains an **Analyst triage Agent**, which writes to the Analyst's pipeline Context. Ordering is safe, because the outer graph waits for the Map. But the registry contract (`kind: utility`) should say explicitly that a utility template may embed role invocations, and which Context those invocations use. Otherwise an implementer will reasonably build a utility kind that has no Agent capability.

## 4. Process

**P1. The resolution record's validation claims cannot be reproduced.** It reports 39 positive and 15 negative schema cases, 4 semantic rejections, 174 resolved links, and SQL rejection tests. None of the scripts or fixtures are in the repository. I could reproduce only the parts I re-ran myself (§1).

**Change:** Commit them, for example `docs/tools/validate-docs.mjs` plus `docs/fixtures/{valid,invalid}/`, and add an `npm run docs:check` script. Since the docs are now strictly cross-referenced, this script is the cheapest way to stop them drifting again. It also becomes the first M1 test asset: the M1 validator must accept and reject the same fixtures.

**P2. Implementation authorization.** All documents still say "documentation only". MILESTONES correctly says that an explicit request to implement M1 under the documented baseline is enough. Only the user can give that request; nothing in this review substitutes for it.

## 5. Recommended next steps

1. Decide M1-1 (failure policy) and M1-2 (where limits live). These are behaviour choices, not edits.
2. Apply M1-3 through M1-6 to the schemas, the DDL, and M1_CONTRACTS.
3. Commit the validation scripts and fixtures (P1).
4. Fix the example map (3.2) and record 3.1, 3.3, and 3.4 in MILESTONES as items in the M4/M5 contract packages.
5. Then M1 implementation can start once the user explicitly authorizes it.
