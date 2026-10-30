# P5-GIT-2 — Managed Git Ancestry, Immutable Host Boundary & Crash Recovery: Implementation Report

**Date:** 2026-10-29  
**Scope:** P5-GIT-2 architecture amendment, production migration and focused integration/recovery tests. This is not full P5 E2E acceptance.

## 1. Final verdict

**P5-GIT-2 VERIFIED WITH LIMITATIONS**

What is proven, with real Git, the authenticated Rust custody Host and separate Engine processes:
- installed-commit ancestry;
- refusal of a moved, missing or digest-mismatched source;
- an independent managed repository;
- direct and indirect Host-change refusal, with Engine-only repairs still accepted;
- Engine-controlled commit and SHA-256 manifest binding;
- recovery at every capture boundary from anchor to final event, without a second candidate, commit, event or Developer launch.

Why it is not the unqualified verdict:
- The recovery proof drives the production durable-capture Engine method from fresh Engine processes. It does **not** run `runner.mjs`/`Engine.initialize` with Custody re-settlement of a real published, enrolled Developer Attempt.
- The installed release in the test is a test-generated release record, not a Host-attested installed package.
- The enrolled-refs fetch fallback was not exercised, because the file:// server accepted the object-ID want.

The overall status remains **P5 IMPLEMENTATION NOT VERIFIED**. `protectedSelfRepairAdmissionEnabled` remains `false`. This report does not claim `READY FOR P6`.

## 2. Starting Git state

- Branch `codex/adr-0003-0005-completion`, HEAD `e34995a2095d3683c225d1435136bf8fb516f0e9` (`p5`).
- Pre-existing unstaged changes from the previous P5 Git preparation:
  - modified: the P5 architecture document, both schemas, `engine.mjs`, `linkedRepair.mjs`, `p5Gate.mjs`, `protectedSelfRepair.mjs` and two P5 tests;
  - untracked: `p5GitCandidate.mjs` and `2026-10-29-p5-git-candidate-preparation.md`.
- Nothing was staged. No reset, rebase, clean or stage was performed. The development checkout was never a Self-Repair target.

## 3. Architecture decision

[Amendment 25](2026-10-29-p5-managed-git-ancestry-and-host-boundary.md) supersedes `sanitized-seed-v1` with `managed-clone-v1` as the target policy and revokes Self-Repair authority over Host/Custody source. [§24](2026-10-28-p5-protected-self-repair-architecture.md#24-p5-git-based-candidate-model--architecture-amendment) is unchanged apart from a supersession pointer and remains the record for historical seed artifacts.

## 4. Files changed

| File | Change |
| --- | --- |
| `runtime/core/p5GitCandidate.mjs` | Policy versioning; enrolled-source validation; policy-bound fetch of the exact installed commit with object-ID → enrolled-ref fallback; persisted fetch result; installed tree / complete-closure / release-digest / ancestry checks; create-only repair branch; non-destructive index population; fetch provenance and Host closure records; fetched-object reachability policy; Host checks before intent, before commit and at verification; ancestry check; fault hooks; publication evaluator |
| `runtime/core/p5HostBoundary.mjs` (new) | Static Host rules, derived Host closure (existing `authorityImportClosure` plus Rust include/path references), boundary assertion |
| `runtime/core/engine.mjs` | `captureProtectedSelfRepairCandidateDurably` (anchor → seal → intent → commit → bind), capture recovery state, projection anchor/intent checks and `capturing` stage, both Git policies wired |
| `runtime/core/protectedSelfRepair.mjs` | New contracts and journal type; Host check in `sealP5Candidate` before scope; managed-clone baseline revalidation without a checkout read; handoff Host-authority flags; **fix:** sealing compared Engine terminal evidence `status` instead of `state` |
| `runtime/core/p5Gate.mjs` | Gate requires a Git candidate for either Git policy |
| `docs/schemas/protected-self-repair.schema.json`, `journal-event-v2.schema.json` | New kinds; additive policy-conditional fields; `self_repair.candidate_capture_started` |
| `runtime/tests/p5-managed-clone.test.mjs`, `runtime/tests/fixtures/p5-capture-engine.mjs` (new) | Focused real-Git, real-Host, multi-Engine-process proof |
| `docs/reviews/2026-10-29-p5-managed-git-ancestry-and-host-boundary.md` (new), architecture §24 pointer, this report | Documentation |

## 5. Reused code

- Store/journal transactions and content-addressed objects.
- `sealP5Candidate`, `inventoryP5SourceWithHost`, `p5CandidateId`, `collectP5GitBaseline` and `prepareP5WorkspaceFromIntent`.
- The pinned `p5GitRun` environment and `verifyP5GitToolIdentity`/`verifyP5GitAttributes`.
- The §24 Git metadata, commit, tree and blob verifiers.
- `authorityImportClosure` and `sourceInventory` from `runtime/host/sourceProvenance.mjs`.
- `custodyFaultPoint`.
- The existing Gate, receipt, Judge and P2 acceptance paths.

No new scheduler, coordinator, database or model decision type was added.

## 6. Managed clone behavior

`git init --object-format --initial-branch=self-repair/<link12> --template=<empty>` runs in `<slot>/source`, with only the allowlisted local config and an empty exclude file. The fetch sets:
- `protocol.allow=never` with only the enrolled protocol allowed;
- an empty credential helper and askpass;
- no redirects;
- fsck enabled;
- `--no-tags --no-write-fetch-head --no-recurse-submodules`;
- the URL taken directly from enrollment, with no configured remote.

Then:
- `update-ref` creates the branch at the installed commit (create-only, zero old value);
- `read-tree` runs only when the index is missing;
- the working tree is the already materialized baseline and must be status-clean.

## 7. Source commit and ancestry evidence (`p5-managed-clone.test.mjs`)

- The upstream fixture has a root commit and an installed commit; the bare origin's `main` was then moved to a later commit. The repair branch is `refs/heads/self-repair/<12 hex> <installed>`.
- `rev-list <installed>` = `[installed, root]`, and `--max-parents=0` is the original root, so there is no synthetic root.
- `sourceAncestryVerified: true`. The fetch strategy recorded was `commit`, with 0 unreachable fetched objects. A held newer commit would be listed as unreachable, never as a ref (asserted).
- A remote holding only the root is refused with `p5_git_source_commit_unavailable`. No branch is created, and the marker-owned repository is retained.
- A release digest that the fetched bytes do not reproduce is refused with `p5_git_source_provenance_mismatch`.
- The managed `.git` common directory is `<slot>/source/.git`, with no remotes and no alternates. The upstream checkout's HEAD, refs, status and index digest are unchanged, and the origin's refs are unchanged.

## 8. Host protection and dependency closure

- **Real repository closure:** the Node Host service closure, computed with `authorityImportClosure` over the 30 `runtime/host` entry points, covers:
  - 11 `runtime/core` modules;
  - `shared/effort.mjs`;
  - `docs/authoring/client-timeouts.json`;
  - all `docs/schemas/*.json`.

  It excludes `engine.mjs`, `linkedRepair.mjs` and the P5 modules.
- **Test (fixture scope deliberately authorizes `lifecycle-host/**`):**
  - `lifecycle-host/src/custody.rs` → `p5_host_boundary_violation` at sealing;
  - `package.json` → refused at sealing;
  - `runtime/core/canonical.mjs`, imported by `runtime/host/lifecycle.mjs`, passes static sealing but is refused before any Git commit intent; no intent is journaled;
  - `runtime/core/engine.mjs` and `src/ui.ts` pass.
- **Static classification asserted** for `Cargo.lock`, `scripts/**` and unknown roots.

## 9. Candidate commit / source digest proof

The candidate commit:
- has exactly the installed commit as parent;
- has diff `[runtime/core/engine.mjs]` with the Developer's bytes;
- has author and committer `Deszo P5 Engine`.

Other checks:
- `verifyP5GitCandidateCurrent` passes.
- The candidate digest equals `p5SourceDigest(manifest)`.
- The Git candidate records `historyPolicy: managed-clone-v1`, `sourceAncestryVerified: true` and the same Host-protection reference as the repository.

## 10. Crash-boundary matrix (each row is a separate Engine process; a fault row ends with a real `process.exit(97)`)

| Engine | Fault / condition | Durable result |
| --- | --- | --- |
| A | `p5_after_capture_anchor` | 1 anchor, 0 intents, branch at installed commit |
| — | Parent Stop | `p5_candidate_authority_changed`; no seal, intent or Git mutation |
| — | live bytes changed after anchor | `p5_capture_source_drift`; no second candidate |
| B | `p5_after_candidate_seal` | sealed objects, still 0 intents |
| C | `p5_before_git_commit` | 1 intent (`candidateId` = anchor's), branch unmoved |
| D | `p5_after_git_commit` | branch at Engine commit, parent = installed |
| E | `p5_after_git_candidate_bound` | binding artifacts, no final event, branch unchanged |
| F | none | projection `capturing`, recovery state `git_commit_pending`; `recovered: true`; same link, Attempt, allocation, candidate ID and commit; terminal evidence from Engine A; attempts table unchanged |
| G | repeated startup | `p5_candidate_already_captured`; counts, branch and `count-objects` unchanged |

Conflicting state:
- source drift → `p5_git_source_mismatch`;
- moved branch → `p5_git_branch_moved`, and the ref is retained, not reset;
- a hand-restored ref stays ineligible with `p5_git_metadata_drift`, because the Host-measured `.git` storage changed.

## 11. Engine A→B recovery evidence

Each Engine process:
- constructs `new Engine({ root })` on the same Store;
- attaches a new Custody epoch, which fences the previous one;
- receives the Developer's terminal record again from the Host via `custody.status`;
- calls the production `captureProtectedSelfRepairCandidateDurably`.

The Developer was a real node process launched once by the Host under Custody in the slot's `source/` directory. Not exercised: `runner.mjs`, `Engine.initialize`/`recover`/`resumeCustodyAttempts` and `settleAgentProcess` for a real published Repair run. The fixture inserts runs and links directly. `captureProtectedSelfRepairDeveloperCandidate` (the Attempt-specific checks) is reached only by that unexercised path.

## 12. Focused test totals

- `p5-managed-clone`: 1/1 passed (final run, about 53 s).
- Batch of `p5-managed-clone`, `p5-native-source-identity`, `protected-self-repair`, `p5-verifier`, `engine-startup`, `linked-repair-isolation`, `parent-repair-coordination` and `workflow-judge-{runtime,scenarios,policy}`, run under PowerShell:
  - first run: 102 tests, 101 passed. The new fetch-provenance assertion found that pre-journal recovery recorded strategy `present`; the fetch result is now persisted in the marker-owned control directory;
  - final run on the final code: **102 tests, 102 passed, exit 0**.
- `npm run docs:check`: zero errors. `npm run build`: passed, with the existing 500 kB chunk advisory. `git diff --check`: exit 0, with only the existing LF/CRLF warnings.
- The Bash-hosted run of the native test fails to locate `git.exe` (environmental; Git Bash's PATH order). It passes under PowerShell, as recorded.
- The full Node and Rust suites were not run.

## 13. Independent review and findings

A fresh-context, read-only review inspected the production code and test evidence and answered the 20 mandatory questions. It did not run tests. A second pass re-verified the fixes.

| Finding | Severity | Disposition |
| --- | --- | --- |
| H1 — the Host's `docs/storage/host-h*.sql` authority migrations, read via `readFileSync` and bundled by `scripts/bundle-runtime.mjs`, were outside the boundary | High, contract-breaking | **Fixed:** `docs/storage/` prefix and `.sql` extension are protected; re-verified |
| H2 — `p5HostBoundary.mjs` was not Host-attested and was itself repairable (two-step weakening) | High, contract-breaking | **Fixed:** the boundary module and `sourceProvenance.mjs` were added to the Gate's `TRUSTED_SOURCE_PATHS`; the P5 enforcement modules are classified `p5_trust_boundary`; re-verified. **Residual, documented (§25.10):** Engine orchestration files that call the boundary stay repairable, so P6 must re-derive the boundary in Host-side immutable code |
| M1 — the derived closure applied only to managed-clone | Medium, contract-breaking | **Fixed:** `sealP5Candidate` derives the candidate closure for every policy before scope and intent. Second-pass residual (an empty closure for partial trees) **fixed**: closure roots are refused when no Host entry point exists (`host_closure_underivable`) |
| M2 — any capture throw fails the Developer Attempt terminally; a transient Host fault after the commit makes the link ineligible | Medium | **Documented** (§25.7) as fail-closed, not resumable; the anchor, commit and workspace are retained. Turning transient faults into a held state is future work |
| L1 — Developer-planted commit-graph / multi-pack-index | Low | **Fixed:** `objects/info/commit-graph(s)` and `objects/pack/multi-pack-index` and its `.d` chain are refused |
| L2 — Stop could be missed during awaits before the commit | Low | **Fixed:** the link is re-checked immediately before staging/commit |
| L3 — a closure violation stranded the anchor in `capturing` | Low | **Fixed** with M1; the violation is now refused at sealing |
| L4 — the anchor is journaled for source-only enrollments; `journalCursor` +4 is unvalidated; older acceptance records without `currentEligibility` raise projection issues | Low | **Residual;** moot while admission stays disabled |
| L5 — publication evaluation does not check that the handoff is journaled and current | Low | **Residual;** evaluation-only, no push path |

The review also noted that the parent-presence loop in `verifyInstalledCommit` adds no proof beyond `rev-list` failing on missing objects. The guarantee rests on `rev-list`, fsck and the refused shallow boundary.

No open Critical, High or contract-breaking Medium finding remains. After the fixes, the 10-file focused batch passed **102/102** (exit 0) and `p5-managed-clone` passed with the new underivable-closure assertions.

## 14. Remaining P5 E2E gaps

- A real installed release from the Host build pipeline and an installation-owned managed-clone enrollment.
- A full P2 → Developer → Gate → Judge → P2 acceptance run through `runner.mjs` with Custody re-settlement after a real Engine crash.
- The enrolled-refs fetch fallback against a server that refuses object-ID wants, and https remotes.
- Index-lock or partial-object crash points inside a single `git commit`. Recovery refuses a leftover `index.lock` rather than deleting it.
- The complete P5 acceptance matrix and the full regression.

## 15. P6 boundaries

The handoff `authority` always records `hostModificationAuthorized`, `hostReplacementAuthorized` and `hostUpdateAuthorized` as `false`, and the schema forbids `true`. P6 must re-derive the Host boundary from the accepted commit independently. P5 contains no Host build, replacement, installation, activation or update code. In the test, the Host executable's digest and mtime were unchanged and the candidate diff contains no `lifecycle-host/` path. Publication is evaluation-only: `P5_GIT_PUBLICATION_PUSH_ENABLED = false`, and the origin's refs are unchanged.

## 16. Final Git state

- Branch `codex/adr-0003-0005-completion`, HEAD unchanged at `e34995a2095d3683c225d1435136bf8fb516f0e9`. Nothing is staged; no commit, push, reset, rebase or clean was run.
- Modified (unstaged): the P5 architecture document (§24 pointer), both schemas, `engine.mjs`, `linkedRepair.mjs` (previous work, untouched here), `p5Gate.mjs`, `protectedSelfRepair.mjs`, and two P5 tests (previous work, untouched here).
- Untracked: `p5GitCandidate.mjs`, `p5HostBoundary.mjs`, `runtime/tests/p5-managed-clone.test.mjs`, `runtime/tests/fixtures/p5-capture-engine.mjs`, the earlier preparation report, the amendment and this report.
- All Git writes during testing targeted test-owned repositories under `.deszo/tests`: fixture upstream, bare origin, missing-commit remote and managed slots. No real remote was contacted, and no installed profile or Host was modified.
- Final checks: `npm run docs:check` zero errors; `npm run build` passed; `git diff --check` exit 0.

## 17. Security limitations

- This is a cooperative execution profile, not a hostile-code sandbox.
- A remote can expose history to the managed repository.
- The static Host rules are conservative and path-based, and the derived closure covers the Node import graph plus Rust include/path references. Native resources referenced by other mechanisms are covered only by the static `lifecycle-host/`, `src-tauri/`, `scripts/` and extension rules.
- The release digest formula mirrors `sourceInventory`, which assumes a clean committed build with no untracked inputs.
