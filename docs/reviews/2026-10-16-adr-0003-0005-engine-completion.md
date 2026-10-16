# ADR-0003–0005 managed execution completion

Date: 2026-10-16  
Branch: `codex/adr-0003-0005-completion`  
Scope: Finish the pending domain-to-engine wiring following the [audit resolution](2026-10-16-adr-0003-0005-audit-resolution.md), preserve the existing fixes and verify the executable lifecycle without provider quota.

The new optional `task-planning-v1` node drives a business request and immutable source through assessment, deterministic stage selection, bounded discovery, separate test/code roles, verification/triage/repair, business acceptance and optional verified local branch delivery. It expands the captured fixed template into ordinary scheduler attempts. It retains API v3 conditional saves and existing execution/confirmation rules. See [the contract](../MANAGED_TASKS.md), [reference workflow](../examples/managed-task/workflow.json), and [engine integration tests](../../runtime/tests/managed-task.test.mjs).

## Completed integration

| Area | Result |
| --- | --- |
| Assessment and plan lifecycle | Captured request/source, explicit models/efforts, stable plan identity across assessment revisions, immutable plan revisions, source-policy floors, bounded discovery and independent confirmation before stage omission. Plans bind the saved workflow, full configuration, compiler version and selected step descriptors. |
| Actual candidate floors | Assembly records the actual diff and a separate floor-evaluation receipt. A critical/public-contract escalation invalidates evidence selection and adds the reference stages. Acceptance requires a passing receipt for the exact current plan/candidate. |
| Role isolation and context | Separate private directories/native bindings for logical steps and code/test reviewers; final Analyst acceptance starts fresh. Policy can require a separately bound business accepter. Review/assessment source mutation blocks the result. |
| CLI retrieval/resume | One JSON envelope, role package, bounded source/evidence requests, exact stream chunk retrieval and ordinary continuation attempts. Missing information stays incomplete without consuming repair iterations. |
| Acceptance authority (A2) | Engine-owned, content-verified evidence resolver bound to task, plan revision, selected evidence, producer, criterion, candidate and boundary. Mandatory configured checks cannot be replaced by model approval. Readiness reviews produce no business acceptance evidence. |
| Managed delivery (A1) | Every Git/smoke child goes through `launchContained`, the process registry, command manifest, local/aggregate timeout, lossless bounded stream capture and ordinary execution evidence. Delivery and smoke consume the shared work budget. |
| Git integrity (A3/A6) | Host publication disables hooks; a fresh owned clone enforces its hook policy. Full manifest v2 verifies binary bytes, deletion and executable modes, staged/committed trees and post-hook cleanliness. Ref preconditions are checked after fetch, with expected-old-value compare-and-swap and a runtime repository/ref lock. |
| Durable recovery (A4/A5 plus delivery intent) | Existing m9/m10 history remains append-only. m11 stores tasks/work/plan-bound evidence/delivery operations and admits uncertain receipts. Intent precedes clone resources/publication; restart interrupts active tasks and requires reconciliation, with no automatic Git retry. |
| Stop and incidents | Root, task and individual command Stop terminate actual smoke children/descendants and halt their owning stage. The root test uses the external `stop-and-report` route and verifies one incident. An uncertain publication cannot emit branch acceptance or `READY_FOR_MERGE`. |
| Observability | UI live task inspector, historical immutable task records in Replay, HTTP navigator, MCP inspection/scoped Stop, and offline task records with transitive artifact closure. Missing/corrupt objects or incomplete capture cannot yield a complete audit verdict. |
| Work accounting | Preparation, retrieval, checks, repair, delivery and smoke share bounds. Reservations and actual launches are distinguished; retries cannot reset limits. Terminal elapsed timing freezes, and restart timing is labeled as a recovery upper bound. |

## Verification

| Check | Result |
| --- | --- |
| Full regression, `npm test` | **465 passed, 0 failed, 0 skipped**; [TAP](evidence/2026-10-16-adr-0003-0005-completion-full.tap). |
| Final managed-task rerun after receipt/accounting changes | **20 passed, 0 failed, 0 skipped**; [TAP](evidence/2026-10-16-adr-0003-0005-completion-managed.tap). |
| Context contract tests, including locale-independent canonical ordering | **10 passed, 0 failed**. |
| Unmodified resolution-audit runner | **8/8**, no input drift; [receipt](evidence/2026-10-16-adr-0003-0005-completion-audit-probes.json). |
| Unmodified follow-up assertion runner | **14/14**, no input drift; [receipt](evidence/2026-10-16-adr-0003-0005-completion-follow-up-probes.json). |
| Documentation/schema checks | Passed; see the [verification receipt](evidence/2026-10-16-adr-0003-0005-completion-verification.json). |
| Frontend type-check/build | Passed; existing large-chunk warning remains. |
| Runtime bundle and actual bundled startup | Passed; migration 11, node/template/capability discovery, DDL equality and retained launch shim verified, with zero provider invocations. |

The complete regression preceded the last task-only receipt/accounting refinements; the final managed-task rerun covers those refinements. The receipt records commands, results and source digests rather than implying that an earlier test snapshot included later edits. The earlier negative runner remains diagnostic and is not counted as an assertion suite.

## Remaining boundaries

- This completes the bounded managed-task integration. The compiler executes one source bundle sequentially; automatic parallel Implementation Map decomposition remains outside this increment. Existing explicitly authored Map workflows passed regression.
- The separate real-provider corpus, controlled-prose comparisons and shadcn/ui pilot were not run. Fixture results establish lifecycle/containment wiring and source/ref invariants, not model quality or token savings.
- Installed-client supervision acceptance remains governed by ADR-0002's exact-version timeout/native-supervisor matrix. No unverified entry was promoted. Headless process-tree tests do not constitute a Windows Job termination proof.
- A6's external checkout race remains: an unrelated Git client can start a checkout after the last precondition check. The local lock coordinates this runtime only; the expected-old-value ref update is atomic. An indeterminate update is explicitly retained for reconciliation.
- Agents/checks still run with the operating system user's permissions. Work directories and declared scopes are not an OS filesystem sandbox. Raw capture is bounded and qualified; unavailable private model reasoning is not reconstructed.

No push, merge or release is part of this change. Existing audit findings/reports and unrelated work are retained.
