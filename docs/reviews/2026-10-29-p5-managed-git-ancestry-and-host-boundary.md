# P5 Amendment 25 — Managed Git Ancestry, Immutable Host Boundary and Capture Recovery

**Date:** 2026-10-29  
**Status:** Architecture amendment for P5-GIT-2. It supersedes the *target* Git candidate policy chosen in [P5 architecture §24](2026-10-28-p5-protected-self-repair-architecture.md#24-p5-git-based-candidate-model--architecture-amendment) and revokes the earlier permission for Self-Repair to change Host/Custody source. §24 remains the historical record for `sanitized-seed-v1`. This amendment does not claim P5 acceptance or readiness for P6; the overall status stays **P5 IMPLEMENTATION NOT VERIFIED** and `protectedSelfRepairAdmissionEnabled` stays `false`.

## 25.1 Why the synthetic seed is superseded

`sanitized-seed-v1` gave a candidate a private Git history that began at an Engine-created root commit. It carried the installed source commit only as an unverified label (`sourceAncestryVerified: false`). An accepted candidate therefore had no Git relationship with the release it repaired. It could not be reviewed as an ordinary descendant, published as a repair branch of the real repository, or rebuilt by P6 from real history without trusting that label.

The target policy is now **`managed-clone-v1`**. The repair branch is a real descendant of the exact commit from which the installed, running Deszo release was built. Ancestry is fetched from an installation-enrolled remote into a private repository in the registered P5 workspace.

## 25.2 Installed-release source provenance

The installed application is built from a committed revision. Its Host-attested release record (`ProtectedSelfRepairRunningSourceRelease`) names `sourceCommit` and `sourceDigest`. The digest is computed by `runtime/host/sourceProvenance.mjs#sourceInventory` over the sorted portable paths and SHA-256 of every captured file. The trust chain is:

```
Host-attested installed package → enrolled running source release → exact sourceCommit
  → fetched Git object graph → tree + complete P5 source manifest → eligible P5 baseline
```

`managed-clone-v1` requires all of the following. Admission fails closed when any one is missing or disagrees.

- The enrollment's `gitSource.sourceCommit`, the baseline `baseCommit` and the release `sourceCommit` are identical. `gitSource.sourceTree` equals the baseline tree.
- `gitSource.releaseSourceDigest` equals the release `sourceDigest`.
- After fetch, the fetched commit's blobs reproduce that release digest under the same formula.
- The P5 baseline manifest is the **complete** committed tree: every path, mode, byte size and SHA-256 matches. A path policy that omits tracked files is refused (`p5_git_source_closure_mismatch`).
- `verifyP5GitBaselineCurrent` does not read any working checkout for this policy (D1). It revalidates the immutable Store baseline objects and the Host-verified running release instead.

Not accepted as source identity: the development HEAD, a working-directory `.git`, a branch name, remote `main`, model output or a typed label.

## 25.3 Trusted remote and retrieval

`enrollment.gitSource` (`ProtectedSelfRepairGitSource`, schema version 1) is installation- or Owner-authorized enrollment data. It binds:
- the source repository ID and remote ID;
- a credential-free `file:` or `https:` URL;
- enrolled fetch-hint refs;
- the installed commit, tree, object format and release digest;
- `credentialPolicy: "none"`;
- a publication policy (§25.9).

The Developer and Judge cannot select any of these.

Retrieval uses the pinned Git executable and P5's scrubbed process environment, which has no system or global configuration and no inherited `GIT_*`. It also sets:
- `protocol.allow=never` with only the enrolled protocol allowed;
- an empty `credential.helper` and `core.askPass`;
- no HTTP redirects;
- `transfer`/`fetch.fsckObjects`;
- `--no-tags --no-write-fetch-head --no-recurse-submodules`.

No remote is configured in the repository and no local ref is written by fetch. The Engine first asks for the exact commit ID. If the server refuses an object-ID want, it asks for the enrolled refs instead. In both cases it then requires the exact installed commit to be present. A moved or force-pushed ref can never replace it, and a missing commit is refused (`p5_git_source_commit_unavailable`) rather than substituted. The recorded `ProtectedSelfRepairGitFetchProvenance` holds:
- the remote ID and URL;
- the strategy and refspecs used;
- the commit, tree and object format;
- the release digest;
- the exact set of fetched objects not reachable from the repair branch.

Remote reachability and history exposure under the cooperative execution profile are accepted operational considerations, not a sandbox guarantee.

## 25.4 Managed repository lifecycle

The repository is `<registered-p5-slot>/source/.git`. It is created with `git init` from an empty template in the existing workspace reservation, after the existing baseline materialization and native identity checks.

Ordinary fetched history makes §24's rule — every object reachable from the one repair branch — inapplicable. The clone policy replaces it with: objects outside the branch must be a subset of the recorded fetched set. All other §24 metadata rules remain:
- an independent `.git` with no common-directory indirection;
- no remotes, alternates, grafts, shallow boundary or replacement refs;
- no refs other than the repair branch;
- an allowlisted configuration and an empty exclude file;
- no hooks, and no filter/EOL attributes.

The Host-measured `.git` storage identity and snapshot also still apply. A repository whose ref was moved and then hand-restored stays ineligible, because its reflog changed the measured storage.

Recovery before `self_repair.workspace_prepared` reuses the marker-owned repository:
- it fetches only when the commit is absent;
- it creates the branch only when it is missing;
- it populates the index only when the index is missing.

A branch with the same name but a different base is refused (`p5_git_branch_conflict`). P5 never runs `branch -f`, `reset`, `clean` or a non-create `update-ref` against unexpected state.

## 25.5 Repair branch ownership and candidate commit identity

The Engine creates `self-repair/<first 12 hex of the durable P2 link UUID>` with a create-only `update-ref` at the installed commit (`seedCommit = sourceBaseCommit`, `sourceAncestryVerified: true`). The Engine controls the candidate commit:
- its single parent is the installed commit;
- it has a fixed Engine author/committer and the durable intent timestamp;
- only the exact sealed manifest paths are staged;
- the index tree and every committed blob are read back and compared byte-for-byte with Store objects.

The canonical P5 source digest (SHA-256 over the complete inventory) remains the content authority. Git commit and tree IDs are additional evidence. Verification also checks `merge-base --is-ancestor <installed> <candidate>`.

## 25.6 Immutable Lifecycle Host boundary

Lifecycle Host source, protocol, trust contracts, build/packaging/installer inputs, binaries and installed state are outside Self-Repair permanently. No profile scope, Judge decision or Repair profile can widen this. The boundary (`runtime/core/p5HostBoundary.mjs`, policy `immutable-host-v1`) has three layers.

1. **Static rules for every P5 policy**, checked inside `sealP5Candidate` *before* the profile scope:
   - path prefixes `lifecycle-host/`, `runtime/host/` (Node Host service and C# Control Host), `src-tauri/`, `scripts/` (build, bundling, install and update), and `docs/storage/`. The Host service reads its `host-h*.sql` authority migrations from the filesystem (`runtime/host/authority.mjs`), and `scripts/bundle-runtime.mjs` ships them in the Host bundle, so an import graph cannot see them;
   - the P5 enforcement modules themselves (`p5HostBoundary.mjs`, `p5GitCandidate.mjs`, `protectedSelfRepair.mjs`, `p5Gate.mjs`, `runtime/verification/`), classified `p5_trust_boundary`, so a first accepted candidate cannot weaken the rules a second candidate is judged by;
   - build/dependency/toolchain basenames anywhere: `Cargo.toml`, `Cargo.lock`, `build.rs`, `rust-toolchain*`, `package.json` and lockfiles, `.npmrc`, `.env*`, `tauri.conf.json`, `.gitattributes`, `.gitmodules`, `.deszo-source-inventory.json`;
   - `.cargo/` and `.github/` segments;
   - native/installer/storage extensions `.rs`, `.cs`, `.ps1`, `.psm1`, `.cmd`, `.bat`, `.wxs`, `.nsi`, `.sql`;
   - root build configuration `vite.config.ts` and `tsconfig*.json`.

   Any path outside the known Engine/UI roots (`runtime/`, `src/`, `shared/`, `docs/`, `mcp/`, `skills/`, `README.md`, `index.html`) is treated as `host_impact_unknown` and refused.
2. **Derived Host closure** recorded at managed-clone preparation (`ProtectedSelfRepairHostProtection`):
   - every `runtime/host/**` entry point and its transitive import graph, using the existing `authorityImportClosure`, which parses modules as data and never loads them;
   - Rust `include_str!`/`include_bytes!`/`include!`/`#[path]` and Cargo `path =` references under `lifecycle-host/`.

   In the real repository this closure includes `runtime/core/{adapters,canonical,migrations,processes,schemas,store,supervision,supervisor-client,transport,utilities,validate}.mjs`, `shared/effort.mjs`, `docs/authoring/client-timeouts.json` and every `docs/schemas/*.json`. It excludes `engine.mjs`, `linkedRepair.mjs` and the P5 modules, so Engine repairs remain possible. A parse failure refuses the derivation instead of returning a partial closure.
3. **Live candidate closure**: for **every** P5 policy, `sealP5Candidate` derives the closure from the candidate tree and refuses a violation before the profile scope and before any Git intent. For Git policies it is derived again before the Engine commit and at each `verifyP5GitCandidateCurrent` (Gate start/finish and acceptance).

A candidate tree with no Host entry points cannot establish the closure. This happens with a partial path policy, which is possible only for source-only or seed enrollments, because managed-clone requires the complete tree. In that case every change under the closure roots `runtime/`, `shared/`, `docs/` and `mcp/` is refused (`host_closure_underivable`).

`runtime/core/p5HostBoundary.mjs` and the `sourceProvenance.mjs` closure parser are in the Gate's Host-attested `TRUSTED_SOURCE_PATHS`. A running copy that differs from the installed release therefore fails harness attestation.

The static rules are still path-based. Filesystem-read Host inputs other than `docs/storage/` and the protected prefixes are found only by the `host_impact_unknown` rule for paths outside the Engine/UI roots; data files under `docs/` other than `docs/storage/` are covered only when they are in the import closure.

Engine-side Custody integration may be repaired only if it is outside all three layers. A repair that would need Host source, protocol or binary changes is ineligible.

## 25.7 Durable capture and crash recovery

The new journal record `self_repair.candidate_capture_started` (`ProtectedSelfRepairCandidateCaptureAnchor`) is committed **before any candidate source object is sealed**. It binds:
- the capture ID, P2 link, runs and incident;
- the Developer Attempt;
- the first Engine's terminal-evidence artifact and the Host terminal identity (custody ID, PID, creation time, invocation and executable digests, exit code);
- the enrollment, prepared-workspace record, allocation and native workspace identity;
- the policy;
- the Host-measured `expectedSourceDigest` and its deterministic `expectedCandidateId`;
- a fixed `capturedAt` and `journalCursor`.

`Engine.captureProtectedSelfRepairCandidateDurably` is the only capture path. It is reached from `captureProtectedSelfRepairDeveloperCandidate` when Custody delivers or re-delivers the Developer's terminal record.

| Durable state at restart | Recovery |
| --- | --- |
| no anchor | first capture; nothing durable existed |
| anchor only | reseal under the anchor's fixed authorization; refuse `p5_capture_source_drift` unless the live digest and candidate ID equal the anchor; content-addressed objects make an identical reseal the same records |
| anchor + Git commit intent | reuse the intent's sealed candidate; never reseal live bytes |
| intent, branch still at installed commit | Engine stages and commits with the intent's deterministic metadata |
| commit exists on the branch | verify parent, identity, tree, blobs, source digest and clean tree, then reuse it |
| Git candidate bound, final event absent | rebind deterministically (`capturedAt` comes from the anchor) |
| `candidate_captured` journaled | `p5_candidate_already_captured`; no Git operation |

Every stage, including the step immediately before the Engine commit, rechecks that the P2 link is open, not stopped, and not invalidated. A capture that throws — a Stop, Host identity uncertainty, source drift or a conflict — fails the Developer Attempt as `capture_failed`. The anchor, any intent or commit, and the workspace are retained unchanged. Because one link permits only one Developer Attempt's candidate, a retry under a new Attempt is refused (`p5_capture_anchor_mismatch`), so the link becomes ineligible rather than silently resuming. This is fail-closed, not resumable. Turning transient Host-uncertainty failures into a held, re-deliverable state is future work. A conflicting anchor, intent or candidate is a projection issue (`capture_anchor_mismatch`, `git_commit_intent_mismatch`, `candidate_anchor_mismatch`) and holds the link. The projection reports an anchored, uncaptured Repair as stage `capturing`, and `protectedSelfRepairCaptureRecoveryState` reports the pending sub-state. P5 never relaunches the Developer, resets or cleans the workspace, deletes the branch, force-updates refs or recreates missing `.git` metadata.

## 25.8 Verification, Judge and P2

The Gate, receipt, review dossier, P4 Judge and P2 acceptance contracts are unchanged. They now accept either Git policy where they previously required `sanitized-seed-v1`. Acceptance reruns `verifyP5GitCandidateCurrent`, which now includes ancestry and the Host boundary. No model decision type, coordinator or model-selected ref was added.

## 25.9 Git publication authority

Publication is a separate external side effect and is not performed in this stage (`P5_GIT_PUBLICATION_PUSH_ENABLED = false`). The enrolled `ProtectedSelfRepairGitPublicationPolicy` binds:
- `enabled`;
- the remote ID;
- the fixed `refs/heads/self-repair/` namespace;
- `requireExpectedRemoteState: true`;
- `allowMerge: false`.

`evaluateP5GitPublication` returns a plan only for an accepted handoff of a managed-clone candidate. The handoff must have current eligibility for the exact commit, receipt and P2 approval, and no Host authority claim. The observed remote ref must be absent or already equal to the commit. A future push must be conditional on the expected old value, and an uncertain push must be reconciled by reading the remote ref. A network failure does not revoke source acceptance.

## 25.10 P5/P6 separation

The handoff `authority` object now always records `hostModificationAuthorized`, `hostReplacementAuthorized` and `hostUpdateAuthorized` as `false`, and the schema makes `true` unrepresentable. P6 may build and activate a compatible Engine/UI release only. It must independently re-derive the Host boundary from the accepted commit, never trusting the historical P5 flag.

That P6 check must run in Host-side code that Self-Repair cannot modify. The P5 enforcement modules are protected, but the Engine orchestration that calls them (`engine.mjs`, `linkedRepair.mjs`, `custody.mjs`, `workflowJudge.mjs`, `runner.mjs`) deliberately stays repairable. An accepted candidate could therefore remove a call to the boundary from a *future* Engine. Only an independent Host-side check at P6 build/activation closes that two-step path.

`src-tauri` is protected, yet it embeds `../dist` and `../dist-runtime`. P6 therefore needs an explicit rule for rebuilding the desktop shell around an accepted Engine/UI change without changing the Host. No Host build, replacement, installation or activation code exists in P5.

## 25.11 Historical compatibility and schema migration

`sanitized-seed-v1` records remain valid and identifiable: the schema keeps `sourceAncestryVerified: false` and forbids clone-only fields for that policy. Old artifacts are not rewritten, converted or given new ancestry. The new kinds (`ProtectedSelfRepairGitSource`, `…GitPublicationPolicy`, `…GitFetchProvenance`, `…HostProtection`, `…CandidateCaptureAnchor`) use `schemaVersion: 1`.

Existing kinds gain these additive fields:
- policy enums;
- `gitRepository.fetchProvenance` and `gitRepository.hostProtection`;
- `gitCandidate.hostProtection`;
- the handoff Host flags;
- the journal event type.

As in §24.8, strict older binaries cannot read the new records, so deployments must upgrade coherently. No database migration is needed.

The Host-boundary static check now also applies to existing source-only and seed enrollments. That is an intentional tightening (D4).
