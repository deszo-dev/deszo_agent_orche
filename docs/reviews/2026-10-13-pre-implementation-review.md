# Pre-Implementation Review of Documentation v0.5

Reviewed: 2026-10-13
Scope: every file under `docs/` (11 Markdown documents, the example bundle, and the map schema), checked against the prototype in `runtime/`, `src/`, and `src-tauri/`.
Verdict: **Not ready to implement as written.** The concepts hold together and the safety principles are strong. Before coding starts, the docs need (a) a much smaller first milestone, (b) the missing core schemas, and (c) fixes for several contract mismatches that would block the reference pipeline.

---

## 1. What is solid

These parts should carry into implementation unchanged:

- **Engine-owned evidence.** Agent JSON never becomes a trusted approval, check report, or state change. Gate certificates, TaskResults, and check reports are engine records (PIPELINE_EXECUTION §1, §3, §7). This is the most important design property, and it is stated consistently.
- **Valid rejection vs. operational failure.** CHANGES_REQUESTED and a nonzero test exit are workflow data. A CLI crash, malformed JSON, or timeout calls for recovery. This distinction is applied the same way in every document.
- **No silent fallback.** No silent provider or model substitution, fresh-session fallback, automatic retry after restart, or "latest" floating references. This matches the prototype's existing guards (`runtime/providers.mjs`).
- **Immutable snapshots instead of commits.** Pinning reviews to result A while B is produced removes a whole class of race conditions.
- **Clear honesty boundaries.** The docs say plainly that Full Access is not a sandbox, Replay restores no state, and Frozen Cache does not recreate native turns.
- **The Implementation Map is split into three records:** documented map, map execution, and navigator projection, with no status written back into the canonical JSON.
- **The worked example is a real scenario.** The round-recovery bundle exercises rejection, approval, parallel work, failed checks, triage, and carry-forward.

## 2. Blocking issues

### B1. The first milestone is too large

Q01 puts all 16 node types into "first implementable scope": nested Loops, Gates with selective carry-forward, Assemble, Test Runner, Map expansion, Replay of dynamic generations, manual Context chat, Cache with planner cuts, and the full reference pipeline. The prototype is about 960 lines with a fixed graph. Q01 lists delivery increments, but every increment ends inside "first version". Nothing is defined as shippable before the full pipeline works.

**Recommendation:** Define milestones with exit criteria that each produce a usable tool:

| Milestone | Contents | Exit criterion |
| --- | --- | --- |
| M1 | Workflow JSON + validator, editor save/load, Text / Prompt Template / Agent / Context / Result Viewer, DAG scheduler, locks, per-run journal | Codex → Claude → Codex scenario (PRODUCT_SPEC §6) runs from a saved workflow and its journal is complete |
| M2 | Merge, File/Artifact Input, JSON Select, Condition, single-level Loop, Stop/Retry/restart recovery, read-only Replay | A Loop with an Agent checker runs, and Replay steps through it |
| M3 | Cache (Live/Frozen), manual Context chat | Q09/Q13 prerequisite rules are covered by fixture tests |
| M4 | Gate, Route, Selected Branch Merge, nested Loops, review-decision schema | Documentation-approval loop works on fixtures |
| M5 | Map, task templates, copied directories, TaskResult, Assemble, Test Runner, triage | Reference pipeline runs on fixtures and a toy project |
| M6 | Navigator UI, Replay of generations, selective carry-forward | Full TEST_PIPELINE §11 exercises pass |

Selective approval carry-forward (PIPELINE_EXECUTION §3) and normative scope closures (§2) are the most complex parts and the least needed early. Ship M4–M5 with **whole-subject re-review only**, which the docs already allow as the default. Add carry-forward afterwards.

### B2. Required schemas are missing

Only the Implementation Map has a JSON Schema. Implementation needs these, and the docs give only prose or a single example:

| Missing contract | Where it is referenced | Current state |
| --- | --- | --- |
| Workflow definition JSON (`schemaVersion: 1`) | Q03, ARCHITECTURE §3 | Prose list of contents; no schema or example |
| Node/port catalogue (per-node config, port names and types) | PRODUCT_SPEC §3, PIPELINE_EXECUTION §1.1 | Utility ports are listed; Text, Prompt Template, Merge, Cache, Loop, Condition config fields are not |
| Task template format and role registry | IMPLEMENTATION_MAP §2, PIPELINE_EXECUTION §1.1 | "Bound templates" are referenced throughout but never defined |
| Task Return envelope | PIPELINE_EXECUTION §1.1 | Three variants named, no fields |
| TaskResult, Candidate, Conflict report | §6 | Field lists in prose only |
| Gate policy and certificate | §3 | Not specified |
| Route configuration | §4 | Not specified |
| Triage decision | §8 | Example only; no rules for required fields or extras, and no `issues` field even though cause `specification` needs to carry issues |
| Journal event types | RUN_HISTORY §2 | Envelope fields only, no event-type catalogue |
| SQLite tables / artifact store layout | Q15, ARCHITECTURE §2 | Entity list only |
| Runtime HTTP/SSE command API | PIPELINE_EXECUTION §10 | List of action names |

**Recommendation:** For each milestone, add the schemas it needs to `docs/schemas/` before coding that milestone. The workflow schema and the event catalogue block M1.

### B3. The Loop contract cannot express the pipeline's loops

LOOPS.md defines a Loop as one `seed` value of one type, a candidate of the same type, and a decision `{continue, reason, feedback}` where `feedback` is a **string**. The reference pipeline needs more than that:

- The **Delivery Loop** carries "specification/issue references, verified prior-map state, and a repair request" (PIPELINE_EXECUTION §5). That is several typed values, and some come from different branches (Map's `specification_revision_required` vs. triage's repair).
- The **Specification Loop** must feed back *structured* issue sets with stable IDs to the Analyst. A string `feedback` loses the issue IDs that `resolvedIssueIds` depends on.
- Loop termination comes from a Gate report (`OPEN` / `REVISION_REQUIRED` / `PENDING`), but Loop Return accepts only the decision triple. The docs never say what converts one to the other. A Condition can derive `continue`, but the Condition contract does not say where its `feedback` comes from.

**Recommendation:** Allow `seed`/candidate to be a JsonValue with a declared schema (a typed record). Allow `feedback` to be a JsonValue, or add a separate structured carry port. Specify, and show in a diagram, the exact node graph inside the Specification Loop and the Delivery Loop: which Route outputs reach Loop Return, and how the Gate report becomes a decision. As written, TEST_PIPELINE §3 is a logical diagram that has not been shown to compile into the primitives.

### B4. "Only re-run missing or stale reviews" has no mechanism

PIPELINE_EXECUTION §5 says the Specification Loop "invokes only required missing/stale reviews", and that "an unchanged approved specification can bypass authoring". In a static DAG body, all three reviewer Agents are execution targets in every iteration. Skipping one would take a per-reviewer Route keyed on carry status. That status is engine data, not graph data, and the docs never describe how it is exposed. Without this, each iteration re-runs every reviewer, which contradicts the carry-forward design and wastes quota.

**Recommendation:** If B1 is adopted, defer this together with carry-forward. Otherwise define an engine-provided "review needed?" JsonValue per reviewer role, or a Gate-integrated review dispatch, and show it in the loop body.

### B5. The time limits contradict the concurrency and timeout defaults

- The Specification Loop limit is **5 iterations / 30 active minutes**. Each iteration runs Analyst (Codex), then Customer (Codex) in sequence because of the one-call-per-provider default, alongside Claude and Antigravity. With a 10-minute Agent timeout and realistic 2–6 minute calls, one iteration takes about 6–15 minutes. Two or three iterations hit 30 minutes, so the five-iteration limit can never be reached.
- Task rework is **3 iterations / 30 minutes per task**. All four task reviews go to one Codex Reviewer slot, which is shared with Analyst and Customer. The docs never say whether **waiting for provider capacity** counts as "active time". If it does, tasks will hit their limits because of queue contention, not because of their own work.

**Recommendation:** State that time spent waiting for capacity or locks is excluded from active time, or count only time attempts are actually running. Then re-derive the template limits from the realistic critical path. Alternatively, make iteration count the primary limit and time a coarse backstop, for example 120 minutes for the Specification Loop.

### B6. The example map understates its normative dependencies

In `examples/round-recovery/SPEC.md`:

- REQ-AUTH contains the **ownership rule** (wrong owner → 403).
- CONTRACT-AUTH says `authenticate()` only throws 401 and "does not inspect round state".
- So the 403 ownership check must live in `src/resume.mjs` or `src/api.mjs`, and REQ-ERRORS's ordering ("verify ownership" after lookup) supports that.

But `TASK-RESUME-CODE` and `TASK-RESUME-TESTS` do **not** list REQ-AUTH in `requirementRefs`, `inputs`, or `readScopes`. Consequences:

1. The resume implementer is never given the 403 requirement it has to implement.
2. If REQ-AUTH's ownership text changes, fingerprint-based carry-forward (IMPLEMENTATION_MAP §9) would wrongly keep the resume code and tests.
3. CHECK-AUTH tests "ownership failure through the public API". Behaviour that belongs to the resume task is therefore checked in the auth suite, so triage for a failed 403 case would point at the wrong task.

The worked failure in TEST_PIPELINE §7.4 ("expired token … receives 403") is also inconsistent: per CONTRACT-AUTH, `authenticate()` can only produce 401, so a 403 for an expired token could come only from a different code path. The example is plausible but not the obvious one.

**Recommendation:** Move the ownership rule into REQ-RESUME/REQ-ERRORS, or add REQ-AUTH to the resume tasks' refs and inputs. Move the ownership cases from CHECK-AUTH to CHECK-RESUME. Change the §7.4 example to a defect that CONTRACT-AUTH can actually produce, for example `expiresAt < now` used instead of `<=` (an off-by-one at the boundary). This is exactly the kind of error that readiness review is supposed to catch, so it is worth fixing in the reference artifact.

### B7. Trusted evidence is stored where Full Access agents can write

PIPELINE_EXECUTION §6: task directories are materialized "under application run storage". Task agents run with Full Access (`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions` in the prototype). The store that holds Gate certificates, TaskResults, check reports, and the journal is therefore within easy reach of every task agent's cwd, often through a simple `..`. "Agent text cannot manufacture trusted approval" is guaranteed at the API level but not at the filesystem level. For a personal tool the threat is accidental damage more than malice, but a confused agent cleaning "temp files" could corrupt the store.

**Recommendation:** Materialize task, reviewer, and runner directories in a sibling root, for example `<appdata>/workdirs/`, separate from `<appdata>/store/`. Keep a SQLite-recorded content hash for every trusted record and verify it on read, so tampering at least shows up as corruption instead of being trusted. State this explicitly in the threat-model paragraph.

## 3. Significant issues (fix before the affected milestone)

**S1. Normative section syntax is undefined.** The spec example uses `## REQ-AUTH` headings as IDs. It also has `## BUSINESS-TASK`, `## IMPLEMENTATION-MAP`, and `## EXAMPLE-REVISION-3`, which are explanatory, not normative, yet nothing marks the difference. "Declared transitive dependencies" (PIPELINE_EXECUTION §2) has no syntax. Is it a Markdown link, an inline `[[REQ-X]]`, or front-matter? The parser and coverage manifest need a concrete grammar: ID pattern, normative/informative marker, dependency syntax. Also, `requirementRefs` and `checkId` share one ID namespace with no type prefix rule, so the validator cannot tell a check section from a requirement section. Either require `CHECK-` and `REQ-`/`CONTRACT-` prefixes or add a section-type marker.

**S2. The Map schema doesn't support "engine-owned" outputs.** TASK-VERIFY declares a `candidate` fileSet whose paths fall outside its `writeScopes: ["reports/**"]`. The validator rule allows this via "except engine-owned assembled candidates", but the schema has no field marking an output as assembled, so the exemption depends on the role name. Add an output kind (`"type": "candidate"`) or a `producer: "engine"` flag. Also, `executorRole: "verification"` means a utility pipeline, not an Agent role, so the role registry (B2) has to cover non-Agent templates.

**S3. Test tasks are accepted without ever running.** TASK-AUTH-TESTS and TASK-RESUME-TESTS are accepted by Codex review alone. A test file with a syntax error, or one that fails against any implementation, is "accepted" and found only at TASK-VERIFY, and every such failure costs a full triage cycle. Consider an optional cheap check criterion on test tasks, such as `node --check` or running the suite against the base and expecting a specific "not implemented" failure.

**S4. Customer isolation is weaker than it reads.** Analyst, Customer, and Reviewer are all Codex on the same account. Separate sessions don't separate native memory, `AGENTS.md`, or personal configuration, which the target deliberately *inherits* (Q08). The docs say Full Access is not isolation, but they don't mention shared provider memory and instructions. Add one sentence saying so, so that "Customer does not see internal source" is not read as a guarantee.

**S5. Codex is a throughput bottleneck.** Codex has three logical roles and every review, under a default limit of one call per provider. The four task reviews, two final reviews, and every triage are serialized. This is acceptable, but the docs should say the default pipeline is Codex-bound and recommend raising the per-provider limit for this template.

**S6. Specification Loop placement.** The Specification Loop is inside the Delivery Loop, yet "an unchanged approved specification can bypass authoring in a later delivery iteration". That needs a Route in front of the Specification Loop (LOOPS §2 allows "Route can skip the Loop"). Show it in the compiled graph from B3.

**S7. Customer's role in documentation review.** The documentation Gate requires Customer approval of a bundle that includes internal contracts (`CONTRACT-AUTH` names `src/auth.mjs`). That conflicts with "Customer does not receive internal source". Define Customer's review scope selector explicitly (BUSINESS-TASK, public REQ-*, ACCEPTANCE-SCENARIOS), and specify how the business package is materialized from the bundle.

**S8. "Run Node" vs. Map tasks.** "Run a task" inside a map is allowed only in an active or paused map execution. Say what happens if the user edits a task template while a map execution is paused. Is the template revision captured at expansion time (as the fingerprint suggests), and does a template edit make the paused execution stale?

## 4. Documentation structure

**D1. Rules are repeated, so the docs will drift.** The same rules appear in up to five places. Locks and concurrency, for example, appear in PRODUCT_SPEC §7, ARCHITECTURE §4.3, BASELINE Q07, LOOPS §7, and PIPELINE_EXECUTION §5. OPEN_QUESTIONS.md is almost entirely a copy of the DECISIONS.md P-table plus links. Every future correction must be applied in four or five places, which the README process already requires ("update … together"). The docs are about 215 KB, and much of that is restatement.

**Recommendation:** Give every rule exactly one normative home:

- PROPOSED_BASELINE (or a renamed `CONTRACTS.md`) holds the rules.
- PRODUCT_SPEC holds UX only.
- ARCHITECTURE holds components and data flow only.
- LOOPS, PIPELINE_EXECUTION, IMPLEMENTATION_MAP, and RUN_HISTORY are the detailed rule homes for their topics.
- Other documents link instead of paraphrasing.

Merge OPEN_QUESTIONS into DECISIONS. Add a precedence line to `docs/README.md`: "if documents conflict, X wins".

**D2. Prose density.** Many paragraphs are lists of compressed clauses ("Run Workflow targets all terminal data outputs; Run Branch targets…"). Implementers will need tables of states, events, and transitions. The task state table (IMPLEMENTATION_MAP §6) and the node state list (Q11) are good. Equivalent tables are missing for map lifecycle transitions, Gate states, run states, and Context binding states (`Needs review` etc.).

**D3. Approval status is unclear.** Everything beyond D01–D18 is "proposed, awaiting user review", and D10 says the current phase is documentation only. Before implementation, record which proposals the user accepts, at least P01, P03, P04, P07, P10, P11, and P15, which M1 depends on. Otherwise the implementation will be built on unconfirmed choices that the docs themselves say must not be inferred from silence.

## 5. Smaller notes

- `README.md` says "Version 0.5 documents…", but the root README mixes prototype instructions with design status. Consider linking only to `docs/README.md` from the root.
- The Cache "Refresh" semantics for a Frozen pin inside a Loop (LOOPS §9) are fine. Rejecting a Frozen Cache between the checker and Loop Return is a good, specific rule; keep it.
- The schema `input.ref` pattern allows `spec:ID` for any ID, including check IDs. Decide whether that is intended.
- `dependsOn` with milestone `result_available` is defined but unused in the example. Add one use, or drop it until needed.
- The Q11 run states (`Waiting for user`, etc.) don't appear in the RUN_HISTORY event list. Add run-state transition events.
- The prototype's Claude invocation uses `--safe-mode --strict-mcp-config`. The target says it will inherit native configuration (Q08). The docs flag this as a deliberate change. Make sure the change happens behind a visible setting, because it changes quota and tool behaviour.

## 6. Suggested pre-implementation checklist

1. User confirms, or changes, the proposals needed for M1 (D3).
2. Adopt a milestone plan with exit criteria (B1).
3. Write `workflow.schema.json`, the node/port catalogue, and the journal event catalogue (B2).
4. Fix the Loop contract for structured carry/feedback, and draw the compiled Delivery and Specification graphs (B3, B4, S6). This is needed by M4 but affects the M2 Loop design, so settle it before M2.
5. Separate the workdir root from the trusted store (B7). This affects M1 storage layout.
6. Fix the round-recovery example (B6, S1, S2) before it becomes the M5 fixture.
7. Deduplicate the docs (D1) before the next round of corrections, not after.
