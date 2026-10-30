# P5-FINAL — Complete Self-Repair, Engine Repairability & Final Acceptance

Date: 2026-10-29. Branch `codex/adr-0003-0005-completion`, HEAD `e34995a2095d3683c225d1435136bf8fb516f0e9` (unchanged; all
P5 work is uncommitted in the working tree). Predecessor: `2026-10-29-p5-e2e-1-first-real-self-repair.md`.

## 1. Final verdict

**`P5 VERIFIED WITH LIMITATIONS — NOT READY FOR P6`**

The core Self-Repair path works end to end on an installed test release, on the final source:

- Engine core (`runtime/core/engine.mjs`) and P5 itself (`runtime/core/protectedSelfRepair.mjs`) are repaired through
  P3 → P4 → P2 → Gate → Repair Judge → handoff.
- There is a causal reproducer: the baseline fails and the candidate passes.
- A real create-only branch publication to a test-owned remote succeeds, and is refused after Parent Stop.

The verdict is not `READY FOR P6` because these required obligations remain open (§25):

1. The distributed desktop (Tauri) package is not P5-capable. The bundled runtime has no attested source layout, so P5
   admission is refused there (`runtime_package_layout`). Every P5 proof ran on the runtime-bootstrap source-layout package.
2. The production Gate has no baseline-failure stage. R(B) fails / R(C) passes is proven by the E2E harness replaying the
   captured reproducer against the managed repository. The Gate itself verifies only that C passes.
3. Several C01–C15 / E2E rows rest on real-integration or deterministic layers rather than installed E2E. The largest gap
   is E2E-14 (uncertain process tree). Partial fetch (E-08) is not tested.
4. Open Medium review residuals: F2 residual, F5, F9, F10, F12, F14 residual (§24).

## 2. Source baseline and Git state

| Item | Value |
|---|---|
| HEAD | `e34995a2095d3683c225d1435136bf8fb516f0e9` (`p5`) — unchanged by this task |
| Index | empty (nothing staged) |
| Development checkout Git operations | none (no stage/commit/push/reset/clean/merge/rebase/ref update) |
| All Git mutations | test-owned repositories under `.deszo/tests/**` (managed clones, bare origins) |
| Real GitHub/GitLab push | none |

## 3. Architecture corrections

| Area | Before | After (P5-FINAL) |
|---|---|---|
| Trust vs mutation | `P5_TRUST_PATHS` blocked candidate edits to Engine/P5 control code | Removed. The active trusted closure is the *installed* `TRUSTED_SOURCE_PATHS` (Host-attested before/after each Gate run). Candidate mutation is governed separately by verification tiers (`P5_MUTATION_TIER_POLICY`) |
| Sensitive changes | n/a | Every non-ordinary path must be executed by a **protected-overlay** check that its tier requires (`p5_mutation_tier_unverified`, `p5Gate.mjs`) |
| Classification | n/a | `classifyP5Mutation` is recorded in the sealed change manifest (`mutationClassification`) and recomputed by `verifyP5Receipt`. Paths are case-folded |
| Host boundary | case-sensitive prefix rules | Case-folded prefixes/basenames/segments; `node_modules`, `.pnpm`, `bower_components` anywhere are protected |
| Shared Engine/Host code | `HostError` lived in `runtime/host/authority.mjs` (SQLite-loading) | Split into `runtime/host/hostError.mjs` (trusted path). `p5Provisioning.mjs` moved to `runtime/core/` |
| Installed packages | bare imports refused | Resolved from `ENGINE_ROOT/node_modules`, materialized beside execution trees, rescanned after the run |
| Import scanning | regex (false positives inside strings) | `ts.preProcessFile`; `node:module`/createRequire and dynamic imports refused in subject closures |
| Large-file review | dossier refused files > 64 KiB | `exact-line-hunk-v1` diff with before/after context verification |
| Publication | not implemented (`P5_GIT_PUBLICATION_PUSH_ENABLED=false`) | `publishP5GitCandidate` + `POST /api/v2/runs/{id}/self-repair/publication`, create-only with durable intent and reconciliation (§9) |
| Admission | — | `runtime_package_layout` admission check: P5 only where the trusted verifier and attested sources exist |

Development-time **Host infrastructure** corrections (not repair candidates, never produced by Self-Repair):

- `lifecycle-host/src/lib.rs`: `managed_relaunch_decision` (bounded relaunch, §22).
- `scripts/bundle-runtime.mjs`: the runner bundle banner now defines `__filename`/`__dirname`. The full regression showed that
  bundling the TypeScript pre-processor broke the desktop Engine at module load. See §23.

## 4. Engine repairability policy

`engine-tiers-v1` (`runtime/core/p5HostBoundary.mjs`, captured into `verificationPolicy.mutationTiers`):

| Tier | Paths (case-folded) | Requirement |
|---|---|---|
| `repair-authority` | `runtime/core/{protectedSelfRepair,p5GitCandidate,p5Gate,p5HostBoundary,p5Provisioning,linkedRepair,workflowJudge,judgeAttention,failureOutcomes,store,migrations,validate,canonical,schemas,utilities}.mjs`, `runtime/verification/`, `docs/schemas/` | required checks ⊇ engine-core checks; ≥ 1 protected-overlay check executes the path |
| `engine-custody` | `runtime/core/{custody,processes,supervision,supervisor-client,workspaceIsolation,managed-isolation}.mjs` | same as above |
| `engine-core` | remaining `runtime/**` | ≥ 1 protected-overlay check executes the path |
| `ordinary` | everything else not Host-protected | policy checks only |

`assertP5MutationTiers` rejects a policy whose tier checks are not a subset of the required checks or which lacks a
protected-overlay check. An unclassifiable path throws `p5_mutation_tier_unclassified`.

## 5. Immutable Host boundary

`p5HostStaticReason` refuses:
- `lifecycle-host/`, `runtime/host/`, `src-tauri/`, `scripts/`, `docs/storage/` (host_source_or_packaging);
- package manifests/lockfiles, `.env*`, `.cargo`/`.github`/`node_modules` segments, root build files (build_or_dependency_input);
- native/installer extensions;
- the derived Host Node import closure plus Rust `include_*` references (host_import_closure).

All matching is case-folded. Installed E2E evidence:
- E1-N05 refuses `lifecycle-host/src/custody.rs`.
- E1-N06 refuses `runtime/core/transport.mjs` (Host import closure).
- E1-N16 shows that requested activation grants nothing.

Every installed case asserts the Host executable digest unchanged and no Lifecycle operation (`collectLifecycleEvidence`).
`p5-managed-clone` covers the case-alias variants (`Node_Modules/`, `Package.json`, `Lifecycle-Host/`, `Runtime/Host/`).

## 6. Installed v1 trust and candidate v2 separation

- The Gate verifier, harness and every `TRUSTED_SOURCE_PATHS` file run from the installed release. Their bytes are
  inventoried by the Rust Host before and after the run, and a mismatch makes the outcome incomplete.
- Candidate code is executed only as the subject of protected checks inside `<slot>/.p5/verify/execution`.
- P5-FINAL-P5-MODULE repairs `protectedSelfRepair.mjs` itself (tier `repair-authority`). The installed P5 issues the
  receipt, and installed files are unchanged afterwards.
- P5-FINAL-NEG-VERIFIER: a candidate that tampers with the verifier and leaves the defect gets no passing receipt.
- P5-FINAL-NEG-AUTHORIZATION: candidate authorization changes are verified as future code and never govern the current repair.

## 7. Real causal repair proof

The Parent worker `custody-p5-parent-probe` runs the test-owned probe, which imports the **installed** subject. A wrong
result produces `P5-INCIDENT {subject,export,args,expected,observed}` and exit 17. P3 records outcome
`provider-failure`/`process`, and its evidence artifact (stderr tail) is the captured Gate input. The protected reproducer
asserts `incident-captured` and `incident-repaired` against that exact captured incident.

| Run | Subject / export | Incident (expected → observed) | R(baseline) | R(candidate) |
|---|---|---|---|---|
| P5-E2E1-HAPPY | `runtime/core/incidentLabel.mjs` `incidentLabel("provider_unavailable")` | `provider unavailable` → `provider` | exit 1 | exit 0 |
| P5-FINAL-ENGINE-CORE | `runtime/core/engine.mjs` `loopStep({iteration:3,maxIterations:3,continue:true})` | `pause_iteration_limit` → `next` | exit 1 | exit 0 |
| P5-FINAL-P5-MODULE | `runtime/core/protectedSelfRepair.mjs` `p5PortablePathOrdering(["src/b.mjs","src/a.mjs"])` | sorted → unsorted | exit 1 | exit 0 |

How R(B)/R(C) are obtained: `replayReproducer` runs the protected reproducer, with the incident inputs copied from Store
objects, on `git archive` of the installed commit and of the candidate commit. **Limitation:** this is harness evidence; the
production Gate does not itself run R against the baseline (F3).

Subject selection: the probe names its subject, and `subjectResolution` binds the protected check to that exact
entrypoint (`p5_subject_not_exercised` otherwise).
P5-FINAL-NEG-ASSERTIONS shows that a candidate rewriting the protected reproducer to pass gets no passing receipt.

## 8. Git source and branch identities

| Run | Installed commit | Repair branch | Candidate commit | Candidate tree |
|---|---|---|---|---|
| ENGINE-CORE | `3e32d84287eea584ad48d8c2d5dfe6bf19460d75` | `self-repair/77c980d58358` | `52d77f03adaf91ab713e4aa9f3a9414e848d0f99` | `90a8970e2a5ce6ee9066c06660d9dc4c44bbca8a` |
| P5-MODULE | `a5d0da75cb86e8136c00b3559ef7a09419bbd9f2` | `self-repair/8944513b0fe8` | `1a7db7536cb53861f16914ef0fec4fcd1bacd22a` | `a1cbf50b56a10c493e46eb588a3269f4929c0e4d` |
| E1-HAPPY | `4bd62d5738fa616ee625a9bff168761f028515bb` | `self-repair/ee123a1e384f` | `77266c448aa5c02dc24e7cdbd3f396286392d6a9` | `dc7f90918d285618aa54089357ccac0d854cb175` |
| E1-RECOVERY | `b6bc595354225e283657da9d62c4114e1322ce08` | `self-repair/4bfceaa7b9b5` | `69ef26a4a89446136d9f8d32d503cc4cac28abe5` | `dc7f90918d285618aa54089357ccac0d854cb175` |

The candidate commit's parent is the installed commit; real ancestry is cloned from the test origin.
`verifyP5GitCandidateCurrent` binds commit/tree to the sealed SHA-256 source. The same fix gives the same tree across the
two E1 runs (`dc7f…`).

Fetch fallback, from `p5-managed-clone` against a protocol-v0 client fixture (`git-v0-client.rs`):
- strategy `enrolled-refs` is used;
- a moved remote ref is not adopted as the baseline;
- a missing commit is refused;
- a credentialed remote URL is refused without being echoed.

## 9. Authorized publication results

The policy is Owner-granted in enrollment (`gitSource.publication.enabled`, `remoteId`, create-only ref pattern). It is
disabled by default and enabled only in the test enrollments.

| Case | Layer | Result |
|---|---|---|
| ENGINE-CORE publish via `POST /api/v2/runs/f4c3d4a4-…/self-repair/publication` | installed E2E | `published`, `pushed: true`. Origin refs are exactly `refs/heads/self-repair/77c980d58358 52d77f03…` plus untouched `main`. Result artifact `cb213dcf-2a13-4829-ae1a-ebe924eb8e15` |
| Same route replay | installed E2E | 200, `replay: true`, no second push |
| P5-MODULE: Parent Stop after acceptance, then publish | installed E2E | 409 `p5_publication_refused` (`handoff_not_current`); origin has only `main` |
| policy disabled / wrong remote / stale eligibility / existing remote ref (conflict) | real Git integration (`p5-managed-clone`) | refused, no write |
| fault after push → reconcile while Parent stopped | real Git integration | the open intent is reconciled read-only via `ls-remote` of the intent's own ref; it is recorded `published`; nothing re-pushed |
| replay after settle | real Git integration | returned with `currentlyEligible`, no push |

Push semantics: `git push --force-with-lease=<ref>: <remote> <commit>:<ref>`, which is create-only (the lease is "absent").
There is no force update and nothing ever touches `main`. The test remotes are local bare repositories, so no
credentials are involved. A credentialed remote URL is refused without being echoed, and no credential is embedded in
artifacts.

## 10. Candidate source/commit manifests

| Run | Candidate id | Candidate source digest | Receipt id |
|---|---|---|---|
| ENGINE-CORE | `02e4f8f945ba0bcf96cf7962f1610c3449fdf485b8a7d3a44e6578d72f48fdef` | `cef5b4970a9daa116b026fa0605ea80df1df5d19a9e1b82d2b1317d8b9478012` | `5149f9cdd3fe71ee3a3553f75c61fbee404b7e63f1acdb36a617c57ce2b402b4` |
| P5-MODULE | `13cb15ee087791b9724361332c9e53d37ee883260e6dda7a5e2091a3a11448dc` | `8394147d672fc3cdd5a2ed4d35536160cefd1871e38d57d30b566d666b383b37` | `df5ec93d412ceac70a906d14e1f8a3f4f263b9876d596fd7d3b033d7fbb51cd7` |
| E1-HAPPY | `6506474af4a6b22b4a0da8dd8774a099e819e86077891c7dff63bf6ebc556a56` | `3e4b2a8ec10fab8a9212dd6d4ed650c85ee7224b72e2226510ea4d508ca6493a` | `fb525319b7c8c09fbceb29c7fd38979afaa26418fd05eeb1f3136286c45acdab` |

Each change manifest records `mutationClassification`:
- ENGINE-CORE: `engine-core` for `runtime/core/engine.mjs`;
- P5-MODULE: `repair-authority` for `protectedSelfRepair.mjs`.

The installed E2E asserts these tiers. The dossier carries `engine.mjs` (> 64 KiB) as an `exact-line-hunk-v1` hunk.

## 11. Runtime-installed and desktop-package proof

- **Runtime-installed (supported P5 profile):** every installed case installs a test release from a test-owned repository
  through the P5-E2E-1 installed-release harness. The flow is:
  1. the release is installed with Host-recorded provenance;
  2. the Rust Lifecycle Host starts the runtime-bootstrap Engine;
  3. the Engine is replaced under the Host.

  The profiles are test-owned; no production installation or user profile was touched.
- **Desktop (Tauri) package:** audited and **not P5-capable**.
  - `dist-runtime/runner.mjs` is an esbuild bundle, so there are no attested per-file sources and no `runtime/verification/p5Verifier.mjs`.
  - The desktop `build.json` has no source provenance.
  - P5 admission refuses it at `runtime_package_layout` instead of failing later in the Gate.
  - The desktop Host lifecycle itself is validated by `tauri-host-proof-b.test.mjs` (§23), but no P5 desktop smoke run exists.
  - Making the desktop distribution P5-capable is a P6 prerequisite (§26).

## 12. Enrollment/admission evidence

Admission is closed when enrollment is missing (E1-N01), from the wrong release (E1-N02) or tampered (E1-N03). These are
installed E2E, run as `P5-E2E1-NEGATIVE E1-N01/N02/N03`. The admission checks now include `runtime_capability`
(`protected-self-repair-v1`) and `runtime_package_layout`.

Legacy profiles do not opt into Custody: `managed P5 enrollment opts into Lifecycle Host Custody before recovery; legacy profiles do not`.

## 13. P3/P4/P2 lifecycle

From the ENGINE-CORE Parent journal:
- `27:attempt.failure_outcome` (P3 outcome `03608a7a-…`, rev 1, incident `93117c6e-…`);
- `41:continuation.linked_repair_opened` (link `77c980d5-…`);
- `48:continuation.repair_result_accepted`;
- `49:continuation.parent_resumption_blocked`. The Parent does not re-run on the old binary; retry is not authorized
  until P6 activation.

The other runs show the same sequence:
- Parent `d1a88935-de4c-4279-898b-7f3135be0deb`, Repair `f4c3d4a4-0fbe-4cba-a454-1daac01c7965`.
- P5-MODULE: Parent `a577237a-…`, Repair `5a8c7200-…`, link `8944513b-…`.

## 14. Developer/Host execution

| Run | Developer Attempt / Custody | Gate Attempt / Custody |
|---|---|---|
| ENGINE-CORE | `b5298d1e-11d3-4ba7-baa7-a1d89b32c9a9` / `0d8dc8a5-eb3b-4b42-91d2-785dad12e153` | `a43bb6b0-20be-48b9-978d-034247e69825` / `d5b22c64-4c85-4a8f-8e64-5b51a547da6d` |
| P5-MODULE | `d66c4281-ea3e-485b-9187-44d63946d57d` / `964c8bc9-2dc3-4186-95b0-00f8fbab32cc` | `6cac1dc0-b423-441a-9fe0-bdecea333683` / `987fb67a-2760-4031-8557-56aa769bc7d4` |
| E1-RECOVERY | `726c0d87-…` / `bc9a3f6b-…` (pid 23808) | `0f74069b-…` / `689117ce-…` (check pid 6072) |

The Developer and the Gate both run under Rust Host Process Custody. E1-RECOVERY replaces the Engine four times (pids
7760 → 22464 → 23532 → 25264, lifecycle generation `c1c1f42e-…`). Each replacement reattaches the same Developer and
Gate processes exactly once.

## 15. Gate verification and receipt

Two required checks: `incident-reproducer` and `authority-regression`, both protected-overlay, with `mutationTiers` captured.

- The receipt binds: candidate, plan, Gate Attempt, Custody, materialized inputs, execution tree, and the admitting Engine
  epoch (E-06).
- The installed dependency set is rescanned after the run (F2).
- NEG-VERIFIER and NEG-ASSERTIONS (installed) show that tampered verification yields no passing receipt.
- Bounded suites cover the rest:
  - JUnit parser rejection;
  - aliased roots;
  - input drift marked incomplete;
  - candidate-edited test syntax.

## 16. Repair Judge and P2 approval

- The Repair Judge receives the dossier (one `judge.evidence_read`) and accepts.
- P2 approval is recorded atomically with the P4 decision. Approval artifacts:
  - ENGINE-CORE `c2d4fbd5-bfe8-484c-ad3b-bc116b76afc3`;
  - P5-MODULE `c5a77f18-c14f-4b15-afaa-c94461a3a822`.
- **Judge question (P5-FINAL-JUDGE-QUESTION, installed):** the Judge asks the Owner question `9e049e94-fbca-4d8c-bf84-f6a00bfa544c`
  after the dossier was delivered. The Owner answers through `POST /api/v2/judge-questions/{id}/answers`.
  - The lineage is carried exactly once (`self_repair.review_delivery_carried`, artifact `1c8700fe-432c-4fed-bacb-1cf39d1cfaa8`).
  - No second evidence expansion happens, and there is one approval.
  - Handoff: `1ab0e2d7577476367b3832603febeda96b0b8ce823b1352d496eb7cfb8f98d37`.
- E1-N11: accepting without the dossier is refused. E1-N12: Parent Stop during the Gate prevents late acceptance.

## 17. Accepted P6 handoff

| Run | Handoff id | Retention record |
|---|---|---|
| ENGINE-CORE | `0f65a8e18844421c7f1c4e6339b9159269fd78e26b551d94d517b6c08a0af1c5` | `7105ab8f-d698-4907-8f80-75154c454328` |
| P5-MODULE | `fc6532c116503a3a63e79f713023bedce42d0843ccf4b0d5254b6ea80afc1687` | `334fa91a-a3b5-4681-a29d-7063c6782de4` |
| E1-HAPPY | `d1de7f47c803694767dcce19f42ced02a6461ea9ea72a6ca4aa51149d4f1e885` | `d6481876-129d-4e00-a59a-91be513df9b8` |

- Handoffs are reconstructed independently from Store objects; a forged or corrupt reconstruction is refused (E1-N18).
- Handoff authority flags (build/install/activate) are false.
- After Parent Stop, current eligibility is revoked and publication is refused (§9).

## 18. Engine core Self-Repair proof

- **P5-FINAL-ENGINE-CORE** (`runtime/tests/p5-e2e.test.mjs`) passed on the final full run (ok 643).
  - The defect was a real Engine control-flow bug: `loopStep` used `>` instead of `>=`.
  - It was repaired through the full installed lifecycle, under tier `engine-core`.
  - The causal reproducer gave baseline 1 / candidate 0, and the result was published (§9).
- **P5-FINAL-P5-MODULE** (ok 644) repaired P5's own source under `repair-authority`. The installed P5 remained the
  verifier, and Parent Stop revoked publication.

## 19. P5-C01–C15 results

Layers:
- **IE** = installed E2E (real installer, Rust Host, Custody, Engine replacement);
- **RI** = real Engine/Host integration;
- **RG** = real Git/filesystem integration;
- **ST** = deterministic Store transaction;
- **U** = unit/helper.

| ID | Boundary | Test(s) | Layer | Last durable state / identity → recovery; duplicate prevention | Verdict |
|---|---|---|---|---|---|
| C01 | Authorized before preparation | `P5 startup recovers a committed pre-Developer preparation intent once and defers while admission is disabled` | ST | prep intent `Kprep` → materialize once; no second slot | pass |
| C02 | Slot allocated before Developer | same + `P5-GIT-2 managed clone … Engine A→B capture recovery` (preparation before event, branch before event) | ST + RG | allocation identity → complete safe baseline or hold; no reset | pass |
| C03 | Developer active on Engine exit | `P5-E2E1-DEVELOPER-RECOVERY…` | IE | same Attempt/Custody/pid → P1 reattach; no second Developer | pass |
| C04 | Developer ended before manifest | `P5-E2E1-DEVELOPER-RECOVERY…` (seal after tree ended) + `P5 candidate capture seals actual add/modify/delete bytes…` | IE + U | ended Attempt → seal once | pass |
| C05 | Captured before verification | managed-clone capture recovery (commit before ref, ref before event, sealed objects without event) | RG | `Kcap`/`Kver` → reuse sealed candidate; no second commit | pass |
| C06 | Verifier active on Engine exit | `P5-E2E1-…GATE-RECOVERY…` | IE | Gate Attempt/Custody → bounded reattach; no second verifier | pass |
| C07 | Verifier complete before receipt | `P5 verifier stages exact captured incident inputs and marks post-check input drift incomplete`; `P5 verification outcomes are strict…` | RI + ST | terminal + spool → receipt only with complete evidence; incomplete never passes | pass (crash exactly between terminal and receipt is not injected at IE) |
| C08 | Receipt before Judge admission | `P5 startup projects bound preparation, verification and P2 terminal stages accurately` | ST | receipt → one P4 attention | pass |
| C09 | Judge active on Engine exit | `P4-E2E-02 and P4-E2E-12: Engine replacement reattaches one live Judge Attempt across generations` (P4 reattach reused by P5) | IE (P4) | Judge Attempt → reattach; no second Judge | pass (not a P5-specific IE) |
| C10 | Judge accepted before P2 reconcile | `P5 Repair approval cannot fall through the generic P4/P2 transaction`; `P2-E2E-03` | ST + IE (P2) | `Kaccept` → idempotent handoff | pass |
| C11 | Parent Stop during verification | `E1-N12: Parent Stop during the Gate prevents late acceptance and handoff`; `active Root Stop commits P5 invalidation…` | IE + ST | Stop cursor → no late acceptance; retain until tree ended | pass |
| C12 | Source changed after verification | `P5 source-drift invalidation is durable, link-bound and idempotent`; managed-clone "metadata changed after capture" | ST + RG | invalidation event → no approval/handoff | pass |
| C13 | Host unavailable / uncertain termination | `P4-E2E-09: uncertain Host termination holds the workspace…`; `F6-03`; `P3-E2E-03` | RI | hold kept until authoritative tree-ended evidence | pass (not P5-specific IE) |
| C14 | Repeated startup | `P5-E2E1-…repeated restart` (4 Engines); `P5 startup projects corrupt linked history as held…` | IE + ST | pure projection replay; no churn | pass |
| C15 | Accepted, P6 not consumed | all installed handoffs + P5-MODULE Stop-after-acceptance | IE | retained graph; later Stop revokes current eligibility | pass |

## 20. P5-E2E-01–18 results

| ID | Test(s) | Layer | Real/mocked | Injection → observed | Verdict |
|---|---|---|---|---|---|
| E2E-01 pinned baseline | E1-N01/N02/N03; all installed cases (installed commit = candidate parent) | IE | real installer, Host | wrong/tampered enrollment → admission closed | pass |
| E2E-02 user source preserved | dev checkout HEAD/index unchanged across all runs; `p5-managed-clone` | RG | real Git | no write to originals | pass |
| E2E-03 actual manifest | `P5 candidate capture seals actual add/modify/delete bytes and refuses scope expansion` | U/RG | real FS | unlisted change included | pass |
| E2E-04 path/scope/topology | `P5 source path policy…`; `P5 inventory requires Windows native topology…`; `P5 native source identity … rejects hard links`; E1-N05/N06; case-folded cases | IE + RI + U | real Host measurement | refused before capture | pass |
| E2E-05 forged verification / subject selection | E1-N08; P5-FINAL-NEG-VERIFIER; NEG-ASSERTIONS; `P5 protected-overlay verifier … rejects broken C despite its edited test` | IE + RI | real Gate | no passing receipt | pass |
| E2E-06 mandatory failure | E1-N07; `P5 JUnit result parser rejects missing protected assertions…` | IE + U | real Gate | no receipt/approval | pass |
| E2E-07 exact binding | `P5 acceptance contract requires the exact receipt…`; `P5 verification start records are strict…` | ST | — | swapped refs refused | pass |
| E2E-08 mutation after checks | `P5 source-drift invalidation…`; managed-clone post-capture metadata change | ST + RG | real Git | invalidated | pass (not IE) |
| E2E-09 correct Judge/evidence | E1-N11; P5-FINAL-JUDGE-QUESTION; all happy runs | IE | real P4 Judge Custody (fixture model) | premature accept refused | pass |
| E2E-10 stale/foreign authority | `P4-E2E-13` (foreign Parent Judge, R1≠R2, forged fields); `negative: the Judge may not propose a candidate other than the linked one` | IE (P4) + ST | — | no approval | pass (not P5-specific IE) |
| E2E-11 Developer Engine replacement | `P5-E2E1-DEVELOPER-RECOVERY…` | IE | real | same Attempt/Custody/pid | pass |
| E2E-12 verifier Engine replacement | `…GATE-RECOVERY…` | IE | real | same Gate Attempt/check pid | pass |
| E2E-13 Parent Stop precedence | E1-N12; P5-MODULE Stop-after-acceptance; `Root Stop invalidates P5 eligibility…` | IE + ST | real | Stop-first: no accept; accept-first: eligibility revoked | pass |
| E2E-14 uncertain tree hold | `P4-E2E-09`; `Proof 3`; custody suites; `managed delivery preserves hooks when runTaskCommand cannot prove…` | RI | real Host | held | **partial** — no P5-specific installed case |
| E2E-15 repeated recovery | E1-RECOVERY (4 Engines) + C01–C15 rows | IE + ST + RG | real | one capture/receipt/approval/handoff | pass (C07/C09 crash points at lower layers) |
| E2E-16 P6 identity | E1-N18; handoff reconstruction in every installed case | IE | real | reconstruct = accepted digest | pass |
| E2E-17 legacy compatibility | P1–P4 suites unchanged and passing; legacy manifest without `mutationClassification` accepted without re-classification; E1-HAPPY `retry_not_authorized` | ST + IE partial | — | identical legacy behavior | pass |
| E2E-18 no activation | E1-N16; handoff authority flags; Host digest unchanged in every IE | IE | real | no Lifecycle op / ref update / install | pass |

## 21. E1-N01–18 results

| ID | Test | Layer | Verdict |
|---|---|---|---|
| N01/N02/N03 | `P5-E2E1-NEGATIVE E1-N01/N02/N03` | IE | pass |
| N04 commit/digest mismatch | `p5-managed-clone` (moved ref not adopted, missing commit refused); `protected-self-repair` identity formulas | RG + U | pass (not IE) |
| N05 | `E1-N05` | IE | pass |
| N06 | `E1-N06` | IE | pass |
| N07 | `E1-N07` | IE | pass |
| N08 | `E1-N08` | IE | pass |
| N09 source/branch change after verification | managed-clone metadata-change + source-drift invalidation; installed publication refuses a non-current handoff | RG + ST + IE (publication) | pass |
| N10 foreign/stale Judge | `P4-E2E-13` lineage cases | IE (P4) + ST | pass |
| N11 | `E1-N11` | IE | pass |
| N12 | `E1-N12` | IE | pass |
| N13 uncertain Host tree | `P4-E2E-09`, Custody suites | RI | pass at RI; no P5 IE |
| N14 crash during candidate commit | managed-clone A→B capture (commit before ref, ref before event, index.lock, partial index) | RG | pass |
| N15 repeated recovery | E1-RECOVERY | IE | pass |
| N16 | `E1-N16` | IE | pass |
| N17 legacy | P1–P4 regression + E1-HAPPY partial | ST + IE partial | pass |
| N18 | E1-HAPPY reconstruction | IE | pass |

## 22. Host relaunch tests

`lifecycle-host/src/lib.rs`: `managed_relaunch_decision` → `RelaunchDecision`. The policy:
- no relaunch after clean exit;
- none while a durable Lifecycle operation is open or a live Engine exists;
- at most 3 relaunches per 60 s;
- an exhausted budget is latched.

The unit test `managed_relaunch_policy_is_bounded_and_never_races` passes.

E1-RECOVERY shows reattachment with Custody identities preserved across 4 Engines. Release builds refuse
`testSetupTokenStdout` (`cfg!(debug_assertions)`, E-05), so relaunch cannot print a production Owner Token.

## 23. Full regression results

The full regression (`npm test`, all tiers, concurrency 1) ran on the source after the review fixes:
**951 tests, 941 pass, 10 fail** (6 098 s). All P5 installed E2E cases passed (ok 641–657).

| Failure | Cause | Disposition |
|---|---|---|
| `AMD-19 inventories every route…` | Expected route counts predate three real P5 routes (`GET installation/source-release`, `GET runs/{id}/self-repair`, `POST …/self-repair/publication`) | Test expectation updated to public 95 / total 104 |
| 7 × `tauri-host-proof-b.test.mjs` | **Regression caused by P5-FINAL**: bundling TypeScript (Gate import scanner) into `dist-runtime/runner.mjs` threw `__filename is not defined` at module load, so the desktop Engine never started | Fixed in `scripts/bundle-runtime.mjs` (banner defines `__filename`/`__dirname`, as the service-runtime bundle already did); bundle import verified |
| `custody-delivery.test.mjs` (file-level) | async activity after `F7 (reverse)` ended (`database is not open`): teardown timing | passed on rerun; not caused by P5 (no P5 code on that path) |
| `managed delivery preserves hooks when runTaskCommand cannot prove…` | **Environmental.** The harness shell sets `NoDefaultCurrentDirectoryInExePath=1`, so the test's fake `taskkill.exe` in the current directory is never found. The real taskkill succeeds, so the "cleanup deferred" path is never reached | Probe confirmed the real taskkill runs from a shadow cwd. The same test **passes** with the variable unset (1/1) |

Rerun of the four affected files on the final source (`amd19-authorization`, `custody-delivery`, `managed-task`,
`tauri-host-proof-b`): **45 tests, 44 pass, 1 fail.** The one failure is the environmental hook test above, which passes
with the variable unset. All 8 Tauri desktop Host proofs pass on the rebuilt bundle (Proof B, Proof B with Custody, the 4
negative desktop cases, the 2 supervised desktop containment cases). Combining the full run, the fixes and the reruns,
no failure attributable to the final source remains.

Other gates on the final source (after the bundle fix):

| Gate | Result |
|---|---|
| `npm run docs:check` | exit 0, `errors: []` |
| `npm run build` (tsc + vite) | exit 0 |
| `cargo test` (`lifecycle-host`) | 27 passed, 0 failed |
| `git diff --check` | exit 0 |
| `node scripts/bundle-runtime.mjs` + import of `dist-runtime/runner.mjs` | bundles; module loads (was `__filename is not defined`) |

The full 951-test suite was not re-run in its entirety after the bundle fix and the AMD-19 count update. Only the
affected files were rerun. The P5 installed E2E (ok 641–657) ran on source identical to the final source in every file
those tests load, except `scripts/bundle-runtime.mjs` (desktop packaging only) and the AMD-19 test expectation.

## 24. Independent review findings

Two fresh-context reviews ran against the P5-FINAL diff:
1. A full review, which produced findings F1–F19.
2. A recheck of the fixes, which read the current code and ran `node --check` on the changed modules.

The table below records each finding's subject and its disposition after the recheck, plus the follow-up fixes. The
original full-review wording and severities for the still-open items were not carried into this session's records, so
severity is given only where the recheck stated it.

| ID | Subject | Disposition |
|---|---|---|
| F1 | Candidate `node_modules` could shadow installed dependencies | Fixed in two steps. First, `node_modules`/`.pnpm`/`bower_components` were made protected segments. The recheck then found a **High, contract-breaking** case-alias bypass (`Node_Modules/`), and all Host rules were case-folded, with tests |
| F2 | Materialized dependencies could be changed during verification | Fixed: post-run set + byte rescan (`verifyInstalledDependenciesCurrent`). **Residual (open):** TOCTOU between checks within one run; dependency set not bound into the receipt |
| F3 | Production Gate does not prove baseline failure | **Open** — limitation 2 |
| F4 | Tier requirement satisfiable by a check that does not exercise the path | Fixed. The recheck found that a syntax-only `candidate-entrypoint` check still satisfied the requirement, so it now must be a protected-overlay check that resolves the path |
| F5 | Tier path lists inconsistent with some module locations | **Open** |
| F6 | Open publication intent not reconcilable once ineligible | Resolved (recheck): reconciled read-only first, using the intent's own ref/commit/remote. Recheck Low note: the `ls-remote` precedes `verifyCurrent`, so a tampered local `insteadOf` could redirect that read (read only, no write) |
| F7 | Live Git candidate check not mandatory before push | Resolved (recheck): `verifyCurrent` is mandatory and wired to `verifyP5GitCandidateCurrent` |
| F8 | Publication eligibility optional; enrollment ref unverified | Resolved (recheck) |
| F9 | Push runs synchronously in the Engine request | **Open** |
| F10 | Transient capture hold has no bound/retry | **Open** (fail-closed hold preserved) |
| F11 | Desktop bundle not verifiable but not refused | Resolved (recheck): `runtime_package_layout` admission check; stated as a product limitation |
| F12 | Possible CRLF/autocrlf mismatch between sealed bytes and Git tree | **Open** (untested with `core.autocrlf=true`) |
| F13 | Legacy manifests re-classified under newer rules | Resolved (recheck) |
| F14 | Module-loader bypass of the subject closure | Partially resolved — **Low** (recheck). Residual: `export { createRequire } from 'node:module'` re-exports and `process.getBuiltinModule` |
| F15 | Review hunk `contextAfter` not verified | Resolved (recheck) |
| F16 | Publication replay identity | Resolved (recheck): replay requires the same handoffId and reports `currentlyEligible`. The recheck found a **Low** regression (an unconditional handoff read before refusal), fixed by an early refusal when no handoff exists |
| F17–F19 | not re-checked | **Open**, as stated by the recheck |

The recheck reported no new Critical/High issues introduced by the fixes. Its one open High (the F1 case alias) is fixed.
The full regression then exposed a Critical-impact regression outside the review's scope: the desktop Engine failed to
start (§23). It is fixed. F3 is the remaining architectural gap and is one reason for the verdict.

## 25. Known limitations and accepted risks

1. **Desktop distribution not P5-capable.** Impact: Self-Repair is available only on the runtime-bootstrap source-layout
   install. Desktop users get a closed admission (safe), not repair.
2. **F3, no Gate baseline stage.** Impact: a policy whose reproducer also passes on the baseline would still yield a
   receipt. Causality is currently a property of the test harness, not of production verification.
3. **E2E-14 / E1-N13** proven at real Host integration only, not with a P5 Developer/Gate tree in an installed run.
4. **E-08 partial fetch** not tested. The other eight E-08 interruption points are covered in `p5-managed-clone`.
5. **C07/C09** crash points use lower layers (Store/real integration, P4 Judge reattach) rather than a P5 installed fault.
6. F2 residual, F5, F9, F10, F12, F14 residual (§24).
7. `dist-runtime/runner.mjs` grew by bundling TypeScript (~12 MB total); it is used only by P5 subject scanning.

Recovery residuals:
- **E-01:** fixed. Transient capture codes (`P5_TRANSIENT_CAPTURE_CODES`) hold instead of failing a committed candidate; integrity violations still fail.
- **E-02:** fixed. The anchor's own committed sequence is used, assigned and verified in the transaction.
- **E-03:** historical records are preserved. Publication requires current eligibility, and replay reports `currentlyEligible`.
- **E-04:** audited. Admission is re-verified synchronously in the acceptance transaction, with a guarded `run_links` CAS; filesystem hashing stays a pre-commit check under the no-external-writer rule.
- **E-05:** fixed. Release Host refuses token stdout.
- **E-06:** documented and enforced. The receipt keeps the admitting epoch; terminal evidence records the settling epoch.
- **E-07:** fixed (§22).
- **E-08:** covered except partial fetch.

## 26. P6 prerequisites

1. A P5-capable desktop distribution (attested source layout or an attested verifier package with provenance in `build.json`), or an explicit decision that P5 is runtime-install-only.
2. A production Gate baseline-failure stage (F3).
3. P5-specific installed uncertain-tree (E2E-14) and partial-fetch cases.
4. Resolution of F2 residual (dependency set bound into the receipt), F9 (asynchronous publication) and F12 (autocrlf).
5. P6 must re-verify the handoff independently and keep the Host outside activation of candidate code.

## 27. Final source/Git operation inventory

- Development checkout: HEAD `e34995a2095d3683c225d1435136bf8fb516f0e9`, empty index, no Git write operation of any kind.
- Modified tracked files:
  - `docs/reviews/2026-10-28-p5-protected-self-repair-architecture.md`
  - `docs/schemas/journal-event-v2.schema.json`
  - `docs/schemas/protected-self-repair.schema.json`
  - `lifecycle-host/src/lib.rs` (Host infrastructure, development-time)
  - `runtime/core/engine.mjs`, `linkedRepair.mjs`, `p5Gate.mjs`, `protectedSelfRepair.mjs`
  - `runtime/host/authority.mjs`, `installedBuilds.mjs`, `sourceProvenance.mjs`
  - `runtime/runner.mjs`
  - `runtime/tests/amd19-authorization.test.mjs`, `fixtures/custody-cli.rs`, `p5-native-source-identity.test.mjs`, `protected-self-repair.test.mjs`, `tiers.json`
  - `scripts/bundle-runtime.mjs` (packaging, development-time)
- New untracked files:
  - `runtime/core/p5GitCandidate.mjs`, `p5HostBoundary.mjs`, `p5Provisioning.mjs`
  - `runtime/host/hostError.mjs`, `runtime/host/runtimeRelease.mjs`
  - `runtime/tests/fixtures/git-v0-client.rs`, `fixtures/p5-capture-engine.mjs`, `p5-e2e-support.mjs`, `p5-e2e.test.mjs`, `p5-managed-clone.test.mjs`
  - the P5 review documents dated 2026-10-29, including this report
- No Host binary was replaced, installed or upgraded by P5. No production installation or user profile was touched.
- No remote other than test-owned bare repositories was contacted. No credentials or tokens appear in artifacts or logs.
