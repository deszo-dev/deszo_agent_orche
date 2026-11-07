# P6-BUILD Independent Trust-Chain Review

**Date:** 2026-11-03 (Europe/Moscow)  
**Stage:** P6-BUILD-REVIEW  
**Baseline branch:** `codex/adr-0003-0005-completion`  
**Baseline HEAD:** `1f54c47fe265c6b47bf36695be56214056fc3af1`  
**Baseline source snapshot:** `f681514a622e5a83a125cbba4cf187402cfdca7eecb63d3b1456a3bec7d5ec84` (826 tracked and non-ignored files)  
**Initial worktree:** 29 modified tracked files and 60 untracked paths; all pre-existing P5/P6 work preserved.

## 1. Initial verdict

**`P6-BUILD REVIEW BLOCKED` (Phase A, before remediation).**

The initial source audit found a false Git provenance claim, a gap between the final P5 eligibility read and durable Host switch admission, and a successor release identity that does not match the Host’s installed source identity. The reported A→B→C test manually creates accepted-looking Store state and calls a test-only activation route; it does not establish genuine P5 acceptance or continuation. These findings prevent acceptance of the previous implementation verdict.

The full Node regression has not been run. The changes in this checkout were uncommitted at review start and remain uncommitted. No clean, stash, reset, rebase, merge or push operation was performed.

## 2. Review scope and method

Phase A was read-only. It inspected P6 production modules, the Engine acceptance and Stop paths, the Rust Host switch protocol, P5 contracts and acceptance code, and the P6/P5 tests and reports. No test or full regression was run during this initial pass.

Primary files inspected include `runtime/core/p6Consumer.mjs`, `p6Reconstruction.mjs`, `p6Scope.mjs`, `p6Builder.mjs`, `p6Successor.mjs`, `p6Continuation.mjs`, `engine.mjs`, `linkedRepair.mjs`, `p5HostBoundary.mjs`, `p5GitCandidate.mjs`, `runtime/host/p6Switch.mjs`, `runtime/host/lifecycleBridge.mjs`, `runtime/runner.mjs`, `lifecycle-host/src/engine_switch.rs`, and the P6 build unit, integration and E2E tests. Contract sources include ADR-0010, the P6 contracts, P5-CLOSURE acceptance, P5 final acceptance, and the P5 managed-Git amendment.

## 3. Evidence matrix (initial audit)

| Claim | Outcome | Initial evidence |
|---|---|---|
| P5 accepted handoff triggers P6 | `PROVEN WITH LIMITATIONS` | `recordLogicalRepairOutcome()` records the P5 handoff and calls `triggerP6Consumer()`; startup projection reconciliation retries eligible handoffs. The A→B→C P6 test itself bypasses this path. |
| P6 rejects arbitrary handoffs without authoritative P5 acceptance | `NOT PROVEN` | The production trigger follows the P5 projection/acceptance path, but `executeP6Activation()` itself does not require an eligible projection or independently bind all handoff identities before it starts reconstruction. The E2E fixture directly inserts accepted-looking state. |
| Immutable source blobs and byte digests are checked | `PROVEN WITH LIMITATIONS` | Reconstruction checks Store refs, bytes, sizes, SHA-256, portable paths and Windows case-fold collisions. It does not independently verify the candidate/Git graph or that the handoff references are the same objects as the P5 candidate. |
| `sourceCommit` and `sourceTree` are genuine Git identities for reconstructed source | `CONTRADICTED` | Builder selects strings from handoff/candidate metadata based on hex format and falls back to a zero-filled hash. It does not verify Git objects, commit contents, tree entries, blob IDs or modes against reconstructed bytes. |
| Candidate cannot control the P6 build executable/config/plugins | `PROVEN WITH LIMITATIONS` | Builder imports installed `esbuild`, uses fixed options and a fixed plugin; scope rejects package/toolchain files, scripts and Host resources. The same-user Engine is cooperative, not an OS sandbox. |
| Two-build reproducibility is performed | `PROVEN WITH LIMITATIONS` | Two source materializations and output roots are used; package and manifest digests and file bytes are compared before receipt creation. Tool/runtime/dependency closure identity is not captured in the receipt, and no test-run evidence was independently reproduced in Phase A. |
| Stop/invalidation is serialized with switch admission | `CONTRADICTED` | P6 reads eligibility, then awaits Engine settling and Host `engine.stage` before `engine.switch`. Stop/invalidation remains admitted during quiescence and can commit after that read; Host does not interpret P5 state. |
| P6 uses G0 phases and process ordering | `PROVEN WITH LIMITATIONS` | Rust Host implements `committed`/`verified` phases and `engine_switch_committed`/`engine_switch_verified` journal events. The P6 report’s `switch_committed` phase wording is incorrect. P6 maintenance entry is a precommit wait in the candidate process. |
| B continuation is bound to the activated package | `CONTRADICTED` | Successor is prepared before package build and uses candidate source digest as `packageSha256`; its `sourceDigest` is P5 tree digest. Host reports the package digest and a distinct installed inventory digest. Continuation compares only build ID and source digest, so a real P6 successor source digest does not match Host evidence. |
| P6 build receipt binds exact accepted handoff/package and survives restart | `PROVEN WITH LIMITATIONS` | Receipt is stored in `command_receipts` before switch and Host verifies package bytes. Builder fabricates the handoff ref when given the dereferenced handoff; receipt replay does not validate receipt kind, handoff ref, operation identity or files against the package in Engine code. No command-receipt cleanup path was found in the reviewed code. |
| A→B→C proves two genuine P5-to-P6 updates | `CONTRADICTED` | Test directly writes candidate, approval, receipt, link and handoff artifacts/rows for B and C, then posts the test-only `/p6-activate` route. C’s handoff is not produced by B’s P5 acceptance workflow and the test does not establish P5 admission through B’s continuation. |
| Scope classifier protects P6/P5 trust code | `PROVEN WITH LIMITATIONS` | `runtime/core/` is allowed, including P6 policy modules; current P5 trusted control paths include those P6 modules and classify them into `repair-authority`. This relies on the P5 strict verification floor, not an immutable-path prohibition. |

## 4. Findings recorded before remediation

### F-01 — Git provenance is a syntactic label, not verified provenance

**Severity:** High  
**Invariant:** The accepted P5 Git commit/tree/blob/mode identity must match reconstructed immutable source.  
**Affected files and functions:** `runtime/core/p6Builder.mjs#buildAndAttestEnginePackage`, `runtime/core/p6Reconstruction.mjs#reconstructCandidateSource`.  
**Actual failure path:** Builder chooses `rawCommit` from handoff fields and accepts any 40–64 character hexadecimal string; invalid input becomes `000…000`. It similarly selects `rawTree` or substitutes the commit. No code hashes Git blob/tree/commit objects from the reconstructed source.  
**Evidence:** `p6Builder.mjs` lines 379–397 (initial audit); P6 contract §1/§3 requires commit/tree/blob/mode verification; P5 Git candidate stores the exact commit/tree under `handoff.gitCandidate`.  
**Reproduction:** A schema-valid fixture with `candidateCommit: "a".repeat(40)` passes the builder’s identity-format branch; the builder never asks whether that commit exists or has the reconstructed tree.  
**Potential impact:** The package and receipt can claim a Git identity unrelated to the source bytes, undermining release provenance and successor baseline identity.  
**Recommended minimal correction:** Require the P5 Git candidate and commit-intent refs, verify their exact handoff/candidate/source lineage, recompute the Git tree from immutable file bytes and modes, and verify the candidate commit object under the fixed P5 commit format. Fail closed on missing or mismatched evidence; remove synthetic hash fallbacks.  
**Affected tests:** P6 unit/integration provenance tests, including altered blob, commit, tree, mode and wrong-handoff cases.  
**Status:** Confirmed in Phase A; corrected in Phase B. P6 now recomputes the Git tree and commit identity from the immutable Store source entries and verifies the linked P5 Git candidate/intent.

### F-02 — Stop can win after P6’s final eligibility read but before Host admission

**Severity:** High  
**Invariant:** A Stop or invalidation that commits before the agreed switch-admission boundary prevents activation.  
**Affected files and functions:** `runtime/core/p6Consumer.mjs#executeP6Activation`, `runtime/host/p6Switch.mjs#requestEngineSwitch`, `runtime/core/engine.mjs#stopRun`, `runtime/core/linkedRepair.mjs#invalidateProtectedSelfRepairForStopInTransaction`.  
**Actual failure path:** P6 reads fresh Parent/link/projection state, then calls `requestEngineSwitch()`. That path can await Run settling, Host staging and other IPC before Host durably accepts `engine.switch`. Root Stop remains a settling operation and records invalidation in the same Store transaction as the Stop. Host does not evaluate P5 state. A Stop committed in that gap is not rechecked before Host acceptance.  
**Evidence:** `p6Consumer.mjs` lines 321–360; `p6Switch.mjs` lines 58–76; `runner.mjs` keeps Stop routes open while quiescing; `stopRun()` records P5 invalidation transactionally. No P6 Store transition serializes Stop with Host admission.  
**Reproduction:** Deterministically hold the Host bridge after the final P6 eligibility read, commit Parent Stop/invalidation through `stopRun()`, then release the Host call. The current path still submits the original package request.  
**Potential impact:** An accepted P5 handoff can activate after its Parent has been stopped or its candidate invalidated.  
**Recommended minimal correction:** Add a durable P6 switch-admission record in the existing Store transaction boundary shared with P5 Stop/invalidation. Whichever transaction commits first determines the boundary; bind the Host request to the immutable operation, handoff and package identity. Do not put Judge logic in Host.  
**Affected tests:** Deterministic Stop before trigger/during build/after verified build/immediately before admission, Stop-vs-final-read, duplicate trigger, generation change, active Engine change and lost switch response.  
**Status:** Confirmed in Phase A; corrected in Phase B. Durable P6 operation intent and Store switch-admission evidence serialize the final eligibility read with Stop/invalidation. The focused admission barrier test passes.

### F-03 — Successor source identity and package identity do not match Host activation evidence

**Severity:** High  
**Invariant:** B’s effective P5 enrollment must bind to the exact Host-installed package and its source inventory before P5 admission opens.  
**Affected files and functions:** `runtime/core/p6Consumer.mjs#executeP6Activation`, `runtime/core/p6Successor.mjs#prepareP6Successor`, `runtime/core/p6Builder.mjs#buildSingleEnginePackage`, `runtime/core/p6Continuation.mjs#resolveP6Continuation`.  
**Actual failure path:** Consumer calls `prepareP6Successor()` before building and omits `packageSha256`; successor records the candidate P5 digest as package digest and source digest. Builder records a different `dirtySourceDigest` computed from `{path, sha256}` inventory rows; the Host returns that inventory digest as `runningSourceRelease.sourceDigest`, while `inputsDigest` carries candidate source digest. Continuation compares successor source digest to Host source digest and does not compare successor package digest to Host package digest.  
**Evidence:** `p6Consumer.mjs` lines 261–286; `p6Successor.mjs` successor release fields; `p6Builder.mjs` lines 265–299; Rust `source_release_value()` returns `dirty_source_digest` and package digest; `p6Continuation.mjs` lines 120–125 checks only build ID and source digest.  
**Reproduction:** For a valid source manifest, `p5SourceDigest(entries)` hashes a `P5SourceTree` object with type/size/mode fields; the Host inventory digest hashes only sorted path/SHA rows. Those distinct canonical payloads cannot be treated as the same identity. B’s continuation therefore fails or can accept without checking the successor package field.  
**Potential impact:** B may have P5 admission closed after activation, preventing the claimed next autonomous repair; a loose match can also accept a package with a mismatched successor record.  
**Recommended minimal correction:** Build both packages first, then create the successor artifacts and receipt using the resulting package digest, verified Git commit/tree, candidate P5 digest and Host-compatible inventory digest. Compare all Host-reported release fields when B validates continuation.  
**Affected tests:** Unit continuation mismatch cases plus a packaged test that asserts B’s effective enrollment is enabled from the actual A→B Host receipt and that C continuation binds its own package.  
**Status:** Confirmed in Phase A; corrected in Phase B. BuildReceipt, package manifest, successor release, policy closure, and Host continuation now use the host-compatible inventory digest plus the attested builder identity; continuation compares the exact Host operation, package and release.

### F-04 — Build receipt’s handoff reference is fabricated

**Severity:** Medium  
**Invariant:** One build receipt must name the exact accepted handoff artifact and package.  
**Affected files and functions:** `runtime/core/p6Consumer.mjs#executeP6Activation`, `runtime/core/p6Builder.mjs#buildAndAttestEnginePackage`, `runtime/core/p6Continuation.mjs#findP6BuildReceiptForRelease`.  
**Actual failure path:** Consumer passes the dereferenced handoff object to the builder. Since the object does not contain an `artifactId`, builder assigns a random UUID and uses `handoff.handoffId` as the ref hash. That reference is not the Store artifact reference from the journal. Continuation does not validate the receipt’s handoff ref.  
**Evidence:** `p6Builder.mjs` lines 463–466; the handoff artifact reference is available as `handoffEvent.payload.record` in `p6Consumer.mjs`; P6 receipt contract requires a `Ref`.  
**Reproduction:** Build any handoff loaded from `self_repair.handoff_recorded`; the generated receipt contains a random artifact ID absent from Store.  
**Potential impact:** Durable receipt lineage cannot prove which immutable P5 handoff produced B and weakens replay/continuation diagnostics.  
**Recommended minimal correction:** Pass the exact event `record` reference into the builder, verify it against the loaded handoff bytes, store that exact ref, and reject receipt replay whose handoff/candidate/operation/package fields disagree.  
**Affected tests:** Assert receipt handoff and candidate refs are exact Store refs; mutate each field and verify replay refusal.  
**Status:** Confirmed in Phase A; corrected in Phase B. The exact event handoff reference is passed through the P6 operation/build and validated on receipt replay.

### F-05 — A→B→C test overstates P5 acceptance and continuation coverage

**Severity:** Medium (evidence gap; contract gate blocker until corrected)  
**Invariant:** A→B→C evidence must exercise genuine P5 acceptance, automatic triggering and release-specific continuation.  
**Affected files and functions:** `runtime/tests/p6-build-e2e.test.mjs`.  
**Actual failure path:** The test writes candidate/receipt/approval/handoff artifacts, directly inserts accepted `run_links` rows and appends `handoff_recorded`; it then POSTs `/api/v4/lifecycle/p6-activate/<run>`. That route exists only in test-marked packages. The C fixture repeats this setup while B is running, without producing C through B’s P5 Developer/Gate/Judge/P2 acceptance workflow or asserting effective P5 admission.  
**Evidence:** `p6-build-e2e.test.mjs` lines 470–574 and 940–1018. `linkedRepair.mjs` contains the real accepted handoff transaction and automatic `triggerP6Consumer()` callback.  
**Reproduction:** Read the fixture setup and activation calls; no P5 workflow attempts or required verification checks create either handoff.  
**Potential impact:** The test proves useful real Host/package switching and two builder runs, but not automatic P5 acceptance or autonomous P5-to-P6-to-P5 continuation. The previous A→B→C description is materially stronger than its evidence.  
**Recommended minimal correction:** Reclassify this test as a packaged P6/G0 integration E2E. Add the smallest practical test using the real P5 accepted handoff transaction and assert automatic consumer invocation; add continuation-specific assertions where feasible.  
**Affected tests:** P5 acceptance/Stop tests and focused P6 integration; the expensive full regression remains a later gate.  
**Status:** Confirmed in Phase A; test/report classification corrected in Phase B. A focused real P5 happy-path test now asserts the production acceptance callback creates a P6 operation tied to the exact accepted handoff/candidate/Git-candidate refs. The A→B→C fixture remains synthetic and did not pass during this review; it is not evidence of two genuine P5 acceptances.

### F-06 — G0 operation phase wording is inconsistent in the implementation report

**Severity:** Low  
**Invariant:** Reports must distinguish a durable phase value from a journal event name.  
**Affected files and functions:** `docs/reviews/2026-11-02-p6-build-implementation.md`; G0 production phase constants in `lifecycle-host/src/engine_switch.rs`.  
**Actual failure path:** The P6 implementation report calls `engineOperation.phase == "switch_committed"`. Production uses phase `committed` (then `verified`); `engine_switch_committed` is a journal event.  
**Evidence:** `engine_switch.rs` defines `PHASE_COMMITTED = "committed"` and emits event `engine_switch_committed`; P6 E2E asserts terminal phase `verified`.  
**Potential impact:** Misleading operational diagnosis and inaccurate protocol description; no Rust Host defect found in this phase.  
**Recommended minimal correction:** Correct the report wording and retain the actual Host phase/event distinction.  
**Affected tests:** Documentation consistency check only.  
**Status:** Confirmed documentation error; corrected in `docs/reviews/2026-11-02-p6-build-implementation.md`.

### F-07 — Scope classifier permits an explicitly excluded MCP bridge update

**Severity:** Medium
**Invariant:** P6 v1 must refuse accepted changes to MCP bridge behavior, as required by ADR-0010 §3.
**Affected files and functions:** `runtime/core/p6Scope.mjs#P6_ALLOWED_RUNTIME_PREFIXES`, `classifyP6CandidateScope`; `runtime/core/p5HostBoundary.mjs#p5HostStaticReason`.
**Actual failure path:** `mcp/` is an allowed prefix. The P5 static Host boundary classifies `mcp/` as an understood Engine/UI root, so an MCP bridge change receives no further rejection and remains buildable by P6.
**Evidence:** The allow-list at P6 scope includes `mcp/`; ADR-0010 §3 explicitly excludes “MCP bridge behavior”; `p5HostBoundary.mjs` includes `mcp/` in `ENGINE_UI_ROOTS` and `CLOSURE_ROOTS`.
**Potential impact:** A P5-accepted MCP behavior change can be activated through P6 despite the documented v1 exclusion.
**Recommended minimal correction:** Explicitly classify `mcp/` changes as unsupported in P6 and add a focused classifier test. Do not change the broader P5 Host boundary.
**Affected tests:** P6 scope unit tests for MCP paths and case variants.
**Status:** Confirmed by the fresh-context read-only reviewer; corrected in Phase B. `mcp/` and case variants now fail the P6 scope classifier, with focused regression coverage.

### F-08 — P5 continuation does not require the Host's durable switch receipt

**Severity:** Medium
**Invariant:** P5 admission after an Engine update must bind the exact Host-committed operation, predecessor, target package and successor profile.
**Affected files and functions:** `runtime/core/p6Continuation.mjs#findP6BuildReceiptForRelease`, `resolveP6Continuation`; `runtime/core/engine.mjs#initializeProtectedSelfRepairEnrollment`; `runtime/host/lifecycleBridge.mjs#p6Call`.
**Actual failure path:** Continuation selects a `p6.build` receipt from Store using build ID and (when present) package SHA, but never queries `engine.switch_status`. It does not compare Host operation ID, from/to identities, phase, package SHA, or Host receipt to the P6 build receipt. Its `p6.continuation` progress row points only to the successor profile and is best-effort. The Rust Host already exposes durable operation status and its receipt.
**Evidence:** The Host returns `operationId`, phase, `fromEngineBuildId`, `toEngineBuildId`, `packageSha256`, and `receipt` from `engine.switch_status`; `p6Continuation.mjs` searches only `p6.build` and records the successor profile reference.
**Potential impact:** A build receipt can be treated as activated without proving that the same Host operation committed that package from the expected predecessor. This also weakens restart and continuation lineage claims.
**Recommended minimal correction:** Persist an immutable operation intent and an exact Store admission receipt in the existing `command_receipts`; on startup, require Host `switch_status` to match operation ID, predecessor, target build, package digest, and committed phase before deriving the effective enrollment. Validate the progress receipt on replay.
**Affected tests:** Continuation tests for wrong operation, predecessor, package, phase, missing Host status, and idempotent replay.
**Status:** Confirmed by the fresh-context read-only reviewer; corrected in Phase B. Continuation now requires the exact durable Host switch status/receipt and binds it to the operation intent, predecessor, package digest and successor release.

## 5. Initial trust-boundary observations

- P5 acceptance itself has a substantial immutable event/artifact projection. The production acceptance path records the accepted handoff and invokes P6 after the P5 acceptance transaction. The P6 consumer currently depends on that path being its only production caller and does not require a fully eligible P5 projection at its own entry point.
- `runtime/core/` is allowed by the P6 scope classifier. Current `P5_TRUSTED_CONTROL_PATHS` includes the P6 policy modules and classifies those changes into `repair-authority`; this is an intentional P5 strict-floor boundary rather than an immutable-path rule. It is not an OS sandbox.
- The builder uses the fixed installed `esbuild` import/configuration and does not invoke candidate package scripts or plugins. Two independent materializations and output directories are compared. This establishes deterministic output for those inputs; it does not establish operating-system isolation or a fully attested dependency closure.
- The test-marked manual activation route is absent from production packages under the package marker policy. The E2E uses it intentionally, so the route itself is not a production activation bypass.
- The Rust Host owns the selector commit, verifies the staged package and runs B’s maintenance preflight before commit. No Host code change is indicated by the initial review.

## 6. Phase B and final evidence

Phase B followed the read-only Phase A findings. Changes preserved the pre-existing uncommitted P5/P6 work; no reset, clean, stash, rebase, merge, commit or push was performed. No production installation or user data was modified. Test roots were isolated under the ignored `.deszo/tests` directory.

### Additional findings from Phase B

#### F-09 — Inherited environment could expose test-only switch routes

**Severity:** High. **Status:** Corrected and covered by a focused unit regression.

The packaged P6 consumer previously accepted `DESZO_TEST_FAULT_HOOKS=1` directly from the inherited Host environment. A production Engine launched by a Host with that environment could register `/api/v4/lifecycle/engine-switch` without a P6 admission callback. The consumer now derives the flag from the package test marker using `testFaultHooksEnabled(import.meta.url)`. The focused test proves an inherited value cannot enable the route policy when the package marker is absent.

#### F-10 — Successor policy kept the predecessor P5 closure digest

**Severity:** Medium. **Status:** Corrected; the independent reviewer accepted the closure binding.

Successor preparation now requires the exact P6 build-input digest. It clones the enrolled verification policy while advancing only `harnessClosureDigest`; continuation verifies every other policy field is unchanged and checks the successor enrollment closure against the Host-attested running release.

#### F-11 — P6 receipt omitted the trusted builder and dependency closure

**Severity:** Medium. **Status:** Corrected in code and unit coverage; end-to-end package evidence remains pending.

The P6 build-input identity now binds the exact immutable source inventory, authority import closure, all files under the installed Engine dependency directory, pinned Git executable identity, Node executable/version, and esbuild package files/version. The two reconstructed source roots must produce identical closures. The BuildReceipt, generated package manifests, successor policy, and Host continuation use the resulting digest. The independent reviewer confirmed the digest relationships in source. The packaged P6/G0 E2E did not reach the builder during this review, so the full installed-package evidence remains incomplete.

#### F-12 — P6 accepted historical `sanitized-seed-v1` provenance

**Severity:** Medium. **Status:** Corrected and covered by the managed-clone fixture path.

P6 reconstruction now requires `managed-clone-v1`, verified source ancestry, the exact enrolled Git source commit/tree/object format, and the Host-attested baseline release. It no longer treats a schema-valid older seed policy as sufficient P6 provenance.

#### F-13 — A→B→C overstated genuine P5 acceptance evidence

**Severity:** Medium evidence gap. **Status:** Reclassified; genuine P5 trigger coverage was added, but the P6 E2E remains unresolved.

`p6-build-e2e.test.mjs` now labels its handoff as fixture-authored and its B→C handoff as synthetic. A separate focused P5 happy-path assertion checks that a real P5 acceptance callback invokes the production P6 consumer for the accepted Repair. Its runtime-bootstrap test installation intentionally lacks a desktop Shell, so the consumer refuses activation after dispatch; this is evidence of the trigger only. That test was rerun after correcting its assertion and its final result is recorded below. This does not turn the fixture-driven P6 test into a genuine P5→P6 build/activation E2E.

#### F-14 — Packaged Engine resolved esbuild outside its attested P5 dependencies

**Severity:** High. **Status:** Corrected with a focused resolver regression; packaged activation remains unverified.

The desktop Engine ships dependencies under `<release>/p5/node_modules`, while the bundled runner leaves esbuild external. A bare import from `<release>/runtime/runner.mjs` could resolve an ancestor development `node_modules` instead. `p6Builder.mjs` now creates its esbuild resolver from `ENGINE_ROOT/package.json`, and both the builder API and package identity use that resolver. A focused test places a different ambient esbuild above the installed package and proves the exact Engine dependency wins. The independent reviewer confirmed this was the missing installed-P5 resolver. The P6 E2E failed before reaching the builder, so no claim is made that an isolated packaged install completed activation.

#### F-15 — Successor P5 can be admitted with an unfetchable managed-clone commit

**Severity:** Medium, contract-breaking continuity gap. **Status:** Unresolved; blocks acceptance.

Continuation advances `sourceCommit`, `sourceTree`, and `releaseSourceDigest` to B but preserves the root `gitSource.fetchRefs`. Managed-clone preparation first fetches the exact B object ID and then falls back only to those enrolled refs. With publication disabled, the accepted B commit is not necessarily advertised by the enrolled remote; P5 publication is a separate Owner-granted action and the handoff itself says `branchPublished: false`. Existing managed-clone tests prove a protocol-v0 server can refuse an unadvertised object ID and that the enrolled-ref fallback fails closed. The independent reviewer confirmed that the current continuation does not read a durable publication result or prove the successor commit is fetchable.

Do not infer publication from an accepted handoff or add an unverified ref. The safe gate is to keep successor P5 admission closed until the exact commit is proven fetchable from the enrolled source policy, or add a separately reviewed Store-backed source method. If immediate continuity is mandatory, activation must wait for an authorized, verified source. Add tests for publication-disabled v0 failure and an enabled, exact published-ref continuation before removing this blocker.

### Final evidence matrix

| Claim | Outcome | Phase B evidence and limitation |
|---|---|---|
| Genuine P5 acceptance automatically invokes P6 | `PROVEN WITH LIMITATIONS` | Focused real P5 happy-path test observes the production consumer invocation for the accepted Repair; its runtime-bootstrap fixture has no desktop Shell, so it verifies dispatch but not P6 build or Host activation. |
| P6 rejects a handoff lacking current accepted P5 projection and exact journal identity | `PROVEN WITH LIMITATIONS` | Production consumer checks the unique immutable handoff event, accepted link, live projection and final transaction admission. Fixture E2E did not establish a valid projection, so the complete path is not newly proven end to end. |
| Store reconstruction is bound to exact Git blob/tree/commit bytes and modes | `PROVEN` | P6 recomputes the Git identities from immutable Store entries and checks exact candidate, intent, enrollment and accepted handoff refs; focused reconstruction/integration tests pass. |
| Trusted builder excludes candidate scripts and binds its installed inputs | `PROVEN WITH LIMITATIONS` | Fixed builder options, exact source/import/dependency/Git/Node/esbuild closure, and two output comparisons are in source. Resolver regression passes. No successful packaged P6 E2E reached the builder in this review. Same-user execution is not an OS sandbox. |
| Two builds are reproducible and receipt binds the output | `PROVEN WITH LIMITATIONS` | Code compares independent outputs and manifests; input-closure and receipt contract tests pass. Full packaged A→B evidence is blocked by the fixture E2E failure. |
| Stop/invalidation and P6 switch admission share a durable boundary | `PROVEN WITH LIMITATIONS` | Store transaction persists final admission after Host staging; Stop/invalidation regression passes. Host remains a byte/package authority and does not duplicate P5 Judge logic. |
| G0 ordering and Host operation identity match the continuation | `PROVEN WITH LIMITATIONS` | Continuation checks Host operation, predecessor, package, phase and release identity; focused continuation test passes. Rust running-release selector test passes. No complete P6/G0 E2E passed. |
| B's P5 continuation is bound to the exact Host-committed release | `PROVEN WITH LIMITATIONS` | Build receipt, Host switch status, release, successor policy and profile identities are checked in source and unit tests. The independent reviewer accepted these bindings. Remote availability of B's Git commit remains unresolved under F-15. |
| Successor keeps Owner-installed budgets, workspace, scope, verification checks and publication policy | `PROVEN WITH LIMITATIONS` | Continuation compares these non-release fields to the root profile/policy and only advances release-bound baseline and closure fields. Unit coverage validates policy continuity; the failing P6 fixture E2E did not exercise the full packaged path. |
| BuildReceipt and continuation replay remain tied to immutable Store/Host records | `PROVEN WITH LIMITATIONS` | Exact Store refs and unique command receipts are checked, and Host operation status is required. Receipt retention/cleanup behavior has no full restart E2E in this review. |
| A→B→C demonstrates two genuine autonomous P5 acceptances | `NOT PROVEN` | The fixture is correctly labeled as synthetic; its current test failed before Host staging. It does not exercise B's fresh managed-clone admission or a real C acceptance. |
| MCP bridge paths are excluded from P6 v1 | `PROVEN` | Explicit scope rejection and case-variant tests pass. |
| Full frozen-snapshot Node regression | `NOT RUN` | Deliberately not run; it is the separate multi-hour final acceptance gate. |

### Focused verification

- `node --test runtime/tests/p6-build-unit.test.mjs runtime/tests/p6-build-integration.test.mjs` — **19/19 passed** (8.5 s). Covers scope, inherited test-hook environment, exact installed esbuild resolution, input-closure digest changes, reconstruction, receipt schema, Host-bound continuation, Stop admission and the two integration refusals.
- `cargo test --manifest-path lifecycle-host/Cargo.toml running_source_release_binds_host_package_and_build_source_fields` — **1/1 passed** (46 filtered out). The test now also asserts that the Host running-source release reports the exact committed operation ID when the active selector supplies one.
- `node --test runtime/tests/p6-build-e2e.test.mjs` — **failed** (1 test, about 323 s). The Host reached Engine A, but no P6 switch was staged. Runner output reported `p5_publication_mismatch`; inspection found the fixture uses different random Repair publication identities in its profile and enrollment and omits the production source-binding/preparation/capture/verification/retention projection events. This is a fixture defect/evidence gap, not evidence that a production P6 activation passed.
- `node --test --test-name-pattern='P5-E2E1-HAPPY' runtime/tests/p5-e2e.test.mjs` — **1/1 passed** (277.2 s). The real Developer/Gate/Judge/P2 path produced the immutable handoff and the production acceptance callback invoked the P6 consumer. The consumer then failed closed because this runtime-bootstrap fixture has no installed desktop Shell release. The first version of the test expected a P6 operation receipt and timed out for that reason; the assertion was corrected to the actual supported evidence, and the rerun passed.
- `node --check` for modified P6/P5 JavaScript and the protected schema JSON parse check passed; final check repeated after the test edit.
- Full Node regression was not run.

### Independent reviewer disposition

A separate fresh-context reviewer inspected the modified production code and tests without editing files or running tests. The reviewer found no remaining Critical issue and accepted the F-10/F-11 closure correction, Stop/admission serialization, Host switch binding, managed-clone source checks, and MCP exclusion. The reviewer confirmed F-14 (now corrected) and F-15 (still unresolved): optional publication can leave the B commit unavailable to the next managed clone. The reviewer also confirmed the real P5 E2E proves acceptance and trigger creation only, while the A→B→C P6 test remains fixture-authored.

### Remediation and final verdict

**`P6-BUILD REVIEW BLOCKED`.** F-15 leaves the successor P5 source potentially unfetchable under the supported publication-disabled policy. The P6/G0 fixture E2E also failed before staging and does not prove a genuine P5 acceptance-to-activation path or B-to-C managed-clone admission. No unresolved Critical issue was reported; one confirmed High issue, F-14, was corrected and has focused resolver coverage. The multi-hour full Node regression remains unrun and is not represented as passed.

**Next action:** establish exact successor Git source availability under the enrolled policy without widening publication authority, then add a packaged test that starts from a real P5-accepted handoff and proves Host activation plus fresh B managed-clone admission. Rerun focused P5/P6/G0 verification, freeze that source snapshot, and only then run the full regression once.

### Source identity and final review state

- Starting branch/HEAD and starting snapshot identity are recorded at the top of this report.
- Final branch: `codex/adr-0003-0005-completion`; final HEAD: `1f54c47fe265c6b47bf36695be56214056fc3af1` (unchanged). Final source snapshot: **827 files**, SHA-256 `3f3edb4c56756b1913c394603c34c8cbd1e201405de073f57a641b702369e6cd`. Method: take `git ls-files --cached --others --exclude-standard`, sort paths, exclude this report, and hash the UTF-8 concatenation of `path`, NUL, the SHA-256 hex digest of file bytes, and newline for each path. The final aggregate SHA-256 is over that concatenation. Ignored `.deszo` test roots are excluded.
- No reset/clean/stash/rebase/merge/commit/push was performed. Full Node regression: not run.
