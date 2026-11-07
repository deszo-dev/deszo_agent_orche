# P5 Git Candidate Preparation — Implementation Report

**Date:** 2026-10-29  
**Scope:** Git-backed private candidate preparation for the existing P5 implementation. This report is not full P5 E2E acceptance.

## Final verdict

**P5 GIT PREPARATION NOT VERIFIED**

The bounded Git substrate now passes its focused fixture checks, including pre-journal seed recovery, exact manifest staging, timestamp validation and native `.git` identity continuity. The fresh review still found Engine restart recovery across source-candidate capture and its atomic `candidate_captured` event unproven. The user's P5 crash-recovery DoD therefore remains open; this report does not mark preparation complete. The overall P5 implementation remains **P5 IMPLEMENTATION NOT VERIFIED** and `protectedSelfRepairAdmissionEnabled` remains `false`.

## Architecture decision

The amendment in [P5 architecture §24](2026-10-28-p5-protected-self-repair-architecture.md#24-p5-git-based-candidate-model--architecture-amendment) selects `sanitized-seed-v1`. The Engine initializes a new ordinary repository from the already sealed source manifest and makes a synthetic root commit. It does not clone, fetch or copy the original repository's commits or objects. The original source commit and repository identity remain provenance fields, not candidate ancestry.

One local branch, `self-repair/<12-hex>`, is derived from the P2 Repair link. The Engine alone stages and creates the final candidate commit after the Developer Attempt is terminal and the P5 source manifest and change manifest agree. The candidate commit has the exact synthetic seed as its only parent. The original P5 canonical source SHA-256 digest remains distinct from Git's object-format-dependent commit and tree IDs; the committed blobs are read back and compared byte-for-byte with the immutable Store source objects.

Git metadata is restricted to the enrolled executable and a scrubbed process environment. The implementation refuses remotes, alternates, replacement refs, extra refs, unsupported config, hooks, checkout filters, redirected metadata and objects not reachable from the sole repair branch. P5 never resets or cleans conflicting workspace or Git state. Recovery reuses an exact committed candidate or refuses and preserves conflicting state.

## Source baseline and repository state

- Workspace: `C:\my\2026\deszo_agent_orche`.
- Branch: `codex/adr-0003-0005-completion`.
- HEAD at task start: `e34995a2095d3683c225d1435136bf8fb516f0e9`.
- The checkout was clean at task start. The reference commit in the pasted continuation text differed from this actual checkout; no branch, commit or worktree was changed to reconcile that discrepancy.
- No Git write operation targeted the original checkout. Fixture `init`, `add`, `commit`, `update-ref`, `remote`, and `hash-object` commands used isolated test-owned repositories.
- No stage, commit, push, merge, rebase, reset or clean was run in the original checkout.

## Implementation

The work adds [p5GitCandidate.mjs](../../runtime/core/p5GitCandidate.mjs) as a narrow Git substrate reused by the existing P5 Engine, source identity, Gate, receipt, P2 approval and handoff contracts. The Engine prepares a private repository only for an enrollment that explicitly selects `sanitized-seed-v1`, seals the existing source candidate first, persists a journaled Git commit intent, creates and verifies the candidate commit, then carries the Git-candidate artifact through the existing candidate-capture event.

The existing P5 canonical source manifest and digest remain the authority for path, byte and mode scope. The Engine force-stages only exact paths from the sealed source/change manifests, including ignored source files, while rejecting ignored extras. Verification and acceptance recheck the bound Git candidate's branch, commit, tree, source bytes, metadata digest and P2 lineage. The native Host directory identity is checked before source-tree enumeration so replacing `.git` is refused directly. Candidate source inventories exclude `.git` only for a Git-bound candidate. Schema additions are optional for legacy source-only records; new Git records have strict version-1 definitions. The architecture amendment documents that strict older binaries cannot consume newly extended records, so mixed-version consumption is unsupported.

The runtime flag is still initialized to `false` and no promotion path was added. There is no installed P5 enrollment in this checkout that selects the new policy. No Git-specific Judge decision, merge/push operation, build activation, installation or binary replacement was introduced.

## Fixture evidence

The passing native Windows test uses Git for Windows' actual `git.exe` and the authenticated Rust Lifecycle Host identity reader. It exercises:

- A private repository seeded from the exact Store-sealed baseline, with an independent `.git` directory and a synthetic root commit.
- Injected failure after seed creation but before the `workspace_prepared` journal event, followed by recovery to the same seed commit and stable durable timestamp.
- One deterministic local Self-Repair branch, no remotes, no original source commit object, no alternates and no copied source ancestry.
- An Engine candidate commit whose tree paths, modes, blob byte sizes and SHA-256 blob contents match the source manifest and change manifest, including a `.gitignore`-matched source file that is explicitly present in the manifest.
- Retry of durable commit intent and recovery of the exact same already-created candidate commit and tree.
- Refusal of a copied `.git` directory at the same path, a moved branch, source drift, configured remote, alternate object store, unreachable object, unsupported filter, missing ownership marker and missing journaled `.git` storage.
- Preservation of the original fixture repository's HEAD, refs, index and status.
- The existing protected verification overlay behavior, including refusal to adopt conflicting pre-existing execution files.

The repeated-commit recovery exercises persisted post-commit state through the production Git adapter. The test does not inject process termination at every partial `git init`, index write, commit-object write, Store write or event append boundary. Most importantly, Engine restart recovery after a source candidate is sealed but before its final candidate-capture event is not proven.

## Modified files

- `runtime/core/p5GitCandidate.mjs` — new private repository preparation, metadata checks, durable commit intent, commit recovery, Git candidate binding and live verification.
- `runtime/core/protectedSelfRepair.mjs` — pinned Git adapter, native Git-tool identity, workspace preparation callback, Git event and receipt validation, Git-aware candidate and handoff evidence.
- `runtime/core/engine.mjs` — opt-in repository preparation and Engine-owned candidate commit integration.
- `runtime/core/p5Gate.mjs` — Gate and receipt binding to current Git candidate identity.
- `runtime/core/linkedRepair.mjs` — additive Git-candidate references in P2 outcome, retention and handoff artifacts.
- `docs/schemas/protected-self-repair.schema.json` and `docs/schemas/journal-event-v2.schema.json` — strict Git artifact definitions and additive references.
- `runtime/tests/p5-native-source-identity.test.mjs` — real Git and Windows Host fixture coverage.
- `docs/reviews/2026-10-28-p5-protected-self-repair-architecture.md` — Git architecture amendment, section 24.
- `docs/reviews/2026-10-29-p5-git-candidate-preparation.md` — this report.

## Validation

- Native Windows Git integration: `runtime/tests/p5-native-source-identity.test.mjs` passed.
- Focused P5, P2 and P4 regression batch: **83 tests passed, 0 failed** across `p5-native-source-identity`, `protected-self-repair`, `p5-verifier`, `engine-startup`, `linked-repair-isolation`, `workflow-judge-runtime`, `workflow-judge-scenarios` and `workflow-judge-policy`.
- `npm run docs:check` passed: 34 schemas, 141 positive schema cases, 82 negative schema cases, 42 negative semantic cases, 148 Markdown files, 1,302 local links and zero errors.
- `npm run build` passed (`tsc -b` and Vite). Vite emitted the existing advisory that one minified bundle exceeds 500 kB.
- `git diff --check` passed; Git printed only the checkout's existing LF/CRLF conversion warnings.
- The full `npm test`, Rust suite and desktop bundle were not run.

## Independent review

One fresh-context, read-only review was requested against the Git substrate, architecture amendment, schemas and integration points. The reviewer did not run tests. The findings and disposition are:

- **Open blocker — Engine restart recovery:** helper replay can reuse an already committed candidate for the exact durable intent, but the Engine has no proven recovery path if it restarts between sealing the source candidate, Git side effects and the atomic `candidate_captured` event. A retry may attempt to seal a time-varying candidate again. This remains a full P5 DoD blocker and is why the verdict is `P5 GIT PREPARATION NOT VERIFIED`.
- **Resolved — pre-journal workspace recovery:** the marker now binds to the durable intent's stable creation time. A marker-owned repository can finish only missing allowlisted config and empty-exclude setup and reuses the same timestamped seed before the prepared event. Conflicting state still fails closed.
- **Resolved — `.git` continuity:** candidate verification checks the Host's native `.git` root identity before enumerating source contents; a copied directory at the same path is refused as an identity mismatch.
- **Resolved — ignored sealed paths:** Git staging now receives exact source/change-manifest paths with force enabled. Ignored files outside the expected change set still fail the diff comparison.
- **Resolved — stale handoff timestamp:** P5 acceptance records the exact Git subject and check time. The P2 outcome and handoff carry that timestamped evidence labeled `p5_acceptance`; they no longer synthesize a later check time. P6 must independently revalidate.
- **Resolved — commit timestamp:** recovery verifies the immutable author and committer timestamps for both synthetic seed and candidate commits.

## Compatibility and remaining gaps

- No valid installed P5 enrollment, trusted installed source release or enabled admission exists in this checkout. The integration could not be exercised as a real enrolled P2→Developer→Gate→Judge lifecycle.
- Gate receipt issuance, accepted P2 settlement, retention, handoff consumption and restart recovery after each late P5 stage remain unverified end-to-end.
- Engine-level crash recovery around candidate capture, and process-crash injection at every commit/Store/event boundary, remain outstanding.
- Older strict-schema binaries cannot read new Git-bound version-1 records; deployments must upgrade coherently before enabling the policy.
- This design does not sandbox hostile Developer code. It relies on the existing P5 workspace, Process Custody and Host guarantees; uncertain Host termination continues to hold eligibility.
- P6 must independently verify immutable stored source objects and the exact commit/tree. No current code publishes, merges, pushes, builds, installs or activates a candidate.

## Git operation inventory

The original checkout remains on the same branch and HEAD with working-tree edits only; nothing was staged or committed. The real Git mutation proof ran exclusively under the test-owned scratch and workspace roots, where the test creates the source fixture commit and the P5 adapter creates the independent seed and candidate commits. The tests intentionally alter only those private fixtures to prove refusal paths. No external remote was contacted; the test remote is an unused `example.invalid` configuration value.

The Git helper and native fixture evidence is recorded, but the open Engine restart recovery blocker prevents a verified preparation verdict. This report does not supersede the earlier overall P5 status or claim `READY FOR P6`.
