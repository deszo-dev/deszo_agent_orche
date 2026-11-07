# ADR-0005 implementation status

Date: 2026-10-16  
Subject: [ADR-0005](0005-verified-feature-branch-delivery.md)  
Status: Verified local branch delivery is wired from managed-task acceptance through the engine-owned launcher, process registry, audit, Stop and aggregate budget. Isolated Git fixtures verify actual branch publication and running-child cancellation. Real-provider/project execution and remote publication remain separate actions.

## What is implemented

| Stage | Implemented | Verified by |
| --- | --- | --- |
| 1. Contracts | Migration `m9.sql` (`branch_deliveries` table); JSON Schemas `delivery-plan.schema.json` and `delivery-result.schema.json`. Exact boundary criteria, candidate digest, and canonical manifest verification. Storage persistence method `Store.recordBranchDelivery`. | `docs:check`, `branch-delivery.test.mjs` |
| 2. Preconditions & isolated checkout | `runtime/core/branchDelivery.mjs`: asserts target ref state (absence for new branch, expected-old-value and ancestry for existing branch - R5) and base commit existence before mutation; verifies clone destination ownership and refuses existing directories (R2); validates candidate file paths against traversal and metadata escapes (R3); creates isolated clone via `--reference --dissociate` or hardlinks (avoiding `--shared` object pruning); host working tree and index remain completely untouched. | `branch-delivery.test.mjs`, `negative-probes.mjs` |
| 3. Delivery execution & commit verification | Enforces hook policy: installs hooks from `hookSource` with executable permissions when enabled (R6), or isolates clone to an empty hooks path when disabled; applies candidate files and asserts working tree against canonical manifest (R4); runs environment smoke checks inside isolated clone with execution timeouts (R7); checks that smoke checks did not mutate working tree or unreviewed files (R4); executes commit and asserts committed tree matches recorded staged tree (R4); executes atomic ref update into host repository using expected-old-value condition; publishes `READY_FOR_MERGE` delivery result with complete evidence. | `branch-delivery.test.mjs`, `negative-probes.mjs` |

## Review findings addressed

The [managed task contract](../MANAGED_TASKS.md) specifies full base-source assertion, binary/deletion/mode-aware manifest version 2, engine-recorded command evidence, repository/ref locking and durable intent/commit/publication receipts. Migration [m11](../storage/m11.sql) adds delivery operations and the `publication_uncertain` persistence outcome. Restart preserves reconciliation data and never automatically publishes; retry after a saved intent is refused.

| Finding | Resolution |
| --- | --- |
| R1 Managed execution & storage | `Store.recordBranchDelivery` is invoked by the managed task after delivery; exact boundary acceptance and delivery receipts are persisted and exposed through UI, HTTP, MCP and offline audit. |
| R2 Refuse existing clone directory | Refuses pre-existing directories at `cloneDir` without recursive deletion; requires fresh owned destination. |
| R3 Path traversal & containment | Validates every candidate relative path, rejecting path traversal (`..`), absolute paths, Windows drive letters, and `.git` metadata escapes. |
| R4 Verified candidate content & tree integrity | Enforces `plan.candidateDigest === canonicalHash(manifest)`. Verifies working tree before/after smoke against unreviewed mutations. Compares committed tree directly to recorded staged candidate tree. |
| R5 Fast-forward & ancestry on existing branches | Checkouts `branchExpectedOldValue` as parent for existing branch delivery, asserts `git merge-base --is-ancestor`, and preserves existing branch commits. |
| R6 Controlled hook installation & isolation | Installs hooks from `hookSource` with `0o755` permissions; rejecting hooks halt delivery. When disabled, redirects `core.hooksPath` to an empty directory so unconfigured hooks cannot run. |
| R7 Execution timeouts | Every Git/check process uses the contained launcher and local/remaining aggregate timeout. `timeoutMs` is now in the plan schema. The 16 MiB protocol buffer is distinct from complete, bounded audit stream capture; truncation/capture failure cannot produce readiness. |
| Audit A1–A6 (follow-up resolution audit) | `executeBranchDelivery` is asynchronous with `AbortSignal` (`stopped`); host publication runs with hooks disabled; preconditions are rechecked before publication; plan revisions persist atomically; existing m9 stores upgrade through `m10.sql`. See the [audit resolution](../reviews/2026-10-16-adr-0003-0005-audit-resolution.md) for the remaining limits. |
| ADR5-S01 Separate clone details | Implemented in `executeBranchDelivery`: uses `--reference <repo> --dissociate` to avoid `--shared` pruning hazards; explicitly manages hooks since fresh clones do not inherit host `.git/hooks`. |
| ADR5-R01 Isolated clone model | Replaces `git worktree` with an isolated separate clone; host working tree, index, and metadata remain untouched. |
| ADR5-R02 Aggregate budget linkage | Delivery attempts and smoke runs count against the plan's aggregate attempt and elapsed-time bounds in ADR-0003. |
| ADR5-R03 Pilot branch baseline | Documented in the [pilot brief](../pilots/shadcn-ui-brief.md) and supported by `branchExpectedOldValue`: existing branches must advance their recorded head commit rather than overwriting. |

## Gates that remain open

- **Live project execution:** Applying delivery to live user repositories or remote publication (push/PR/release) requires separate authorization.
- **External Git race (A6):** Preconditions are rechecked after object fetch and before ref compare-and-swap. An unrelated checkout starting after that check cannot be excluded by a runtime-local lock; the boundary is disclosed rather than claimed solved.
- **Installed supervision acceptance:** The existing exact-client/native-supervisor support gates still apply. Headless fixtures prove wiring/process-tree cancellation without claiming a Windows Job proof or measuring real-model execution.

