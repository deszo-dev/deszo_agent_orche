# P6 Final Acceptance — Report C (2026-11-05)

## Verdict

**VERIFIED WITH LIMITATIONS.** Not ready for release review until the items under "Open items before release review" are closed.

The frozen source snapshot passes every check in the Results table: the full Node regression, the Rust lifecycle-host suite, the supporting checks, and the genuine A→B→C and workspace-exhaustion E2E. Three things keep the verdict below "ready for release review": the release artifacts were not stable during the full Node run and had to be restored; two shell and launch-shim hashes do not match the 2026-11-05 freeze manifest and their cause is not established; and the restructured P6 wiring has not had an independent security review.

Nothing was committed, pushed or merged. `HEAD` is `1f54c47`; the uncommitted work is preserved.

## Scope

Stage III of the P6-FINAL-CLOSURE program: regression, genuine E2E and acceptance on one frozen snapshot. Stages I (native Host commit-window race, M1) and II (security review and blocker closure) were recorded earlier.

## Frozen snapshot

- Method: sorted `git ls-files --cached --others --exclude-standard`, excluding `.deszo/` and `docs/reviews/evidence/`; each entry `path NUL sha256 newline`; digest is SHA-256 of the concatenation. Script: [freeze.mjs](evidence/2026-11-05-final-acceptance/freeze.mjs).
- Files: **660**.
- **Digest: `18d5a06dfc30bd83d4641305a609ad6fe6ce1b58fe5f8760fda4bf0d78833d19`**
- Re-verified with no source change after: the full Node run, the production artifact restore, the genuine E2E run, and the evidence rerun. Post-run manifests: [post-node-manifest.json](evidence/2026-11-05-final-acceptance/post-node-manifest.json), [post-prod-restore-manifest.json](evidence/2026-11-05-final-acceptance/post-prod-restore-manifest.json), [post-e2e-manifest.json](evidence/2026-11-05-final-acceptance/post-e2e-manifest.json), [post-evidence-run-manifest.json](evidence/2026-11-05-final-acceptance/post-evidence-run-manifest.json).
- Freeze manifest: [2026-11-05-p6-final-snapshot-manifest.json](evidence/2026-11-05-p6-final-snapshot-manifest.json).
- Superseded freezes (not used for acceptance): 2026-11-04 `9b1615714e8f30adba598e92d53554694718050c70a19abafddff9e5e264b178`; 2026-11-04 superseded-1 `d9d105feac0a6c89d64fa0df60ba8cf1da82ccc482d7a43d850de266c77cfb6f`.
- This report is written after the verified digest and is not part of that snapshot. Its only addition is the new file under `docs/reviews/`.

## Results

| Check | Command | Result | Exit | Evidence |
|---|---|---|---|---|
| Full Node regression | `npm test` (`node scripts/run-tests.mjs full`) | `# tests 1071`, `# pass 1071`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`; `duration_ms 12030816.6519`; 06:30:18Z–09:50:52Z; 0 `not ok` lines | 0 | [s5b-npm-test-full.log](evidence/2026-11-05-final-acceptance/s5b-npm-test-full.log) |
| Earlier Node attempt | same | Stopped at custody group (tests 31–34, exitCode 3221226091), parent exit 4. Did not recur in the run above. Cause not established. | 4 | [s5-npm-test-full.log](evidence/2026-11-05-final-acceptance/s5-npm-test-full.log) |
| Rust lifecycle-host | `cargo test --manifest-path lifecycle-host/Cargo.toml` | `running 47 tests`; `47 passed; 0 failed`; 47 `#[test]` in `lifecycle-host/src` | 0 | [s6-cargo-test.log](evidence/2026-11-05-final-acceptance/s6-cargo-test.log) |
| Tier catalog | `npm run test:tiers` | pass | 0 | [s6-test-tiers.log](evidence/2026-11-05-final-acceptance/s6-test-tiers.log) |
| Docs | `npm run docs:check` | pass | 0 | [s6-docs-check.log](evidence/2026-11-05-final-acceptance/s6-docs-check.log) |
| Build | `npm run build` (`tsc -b && vite build`) | pass | 0 | [s6-build.log](evidence/2026-11-05-final-acceptance/s6-build.log) |
| Whitespace | `git diff --check` | CRLF notices only | 0 | [s6-diff-check.log](evidence/2026-11-05-final-acceptance/s6-diff-check.log) |
| Genuine A→B→C and exhaustion E2E (run 1, no evidence dir) | `node --test runtime/tests/p6-genuine-e2e.test.mjs` | `# pass 2`, `# fail 0`; 1490925.59 ms | 0 | [s8-genuine-e2e.log](evidence/2026-11-05-final-acceptance/s8-genuine-e2e.log) |
| Genuine A→B→C and exhaustion E2E (run 2, evidence captured) | same, with `DESZO_P6_GENUINE_EVIDENCE_DIR` | `# pass 2`, `# fail 0`; 1130309.27 ms | 0 | [s9-genuine-e2e-evidence-run.log](evidence/2026-11-05-final-acceptance/s9-genuine-e2e-evidence-run.log) |

Run 1 wrote no evidence, because the test writes evidence only when `DESZO_P6_GENUINE_EVIDENCE_DIR` is set. The 2026-11-04 evidence files in `docs/reviews/evidence/` predate this freeze and are not cited. Run 2 wrote the evidence below.

### Genuine E2E evidence (this freeze)

- Directory: [docs/reviews/evidence/2026-11-05-genuine-e2e-run/](evidence/2026-11-05-genuine-e2e-run/). The file names keep the test's hard-coded `2026-11-04` prefix.
- A→B→C chain: Engine A's Repair produced B and B's Repair produced C, both activated automatically. The two recorded claims, on `p5-slot-2` and `p5-slot-1`, both succeeded.
- Claimed-slot refusal: a second claim on `p5-slot-1` returned `409 p5_workspace_reserved`.
- Exhaustion (two-slot pool): B activated; the successor of B was refused with `p6_successor_workspace_exhausted` ("no operation, build or Host staging was started"). Recorded `stagedEvents: 1`.
- The P6 builder runs in the Engine process; the Host side uses the fixture provider. **This is not a live-model test.**
- Owner actions: 14 setup calls (A), 13 (exhaustion); no forbidden actions recorded.

## Changes made in this stage

1. **P6 builder wiring (restructure).** The builder was removed from the static import chain of `p6Consumer.mjs`: the P5 subject resolver refused its `createRequire` import. The builder is now injected: `Engine` takes a `p6Builder` option, `runner.mjs:140` is the only non-test construction site and passes it, and `p6Consumer.mjs:421–423` refuses with `p6_builder_unavailable` before any operation, build or Host staging. The resolver itself is unchanged. Diff against the verified baseline: [2026-11-05-p6-consumer-builder-injection.diff](evidence/2026-11-05-p6-consumer-builder-injection.diff).
2. **Test fixtures and harness (uncommitted):**
   - `runtime/tests/p5-e2e.test.mjs`: pins the System32 `tar.exe` (Git's `tar` mis-resolved `C:`); matches the exact P6 consumer refusal line.
   - `runtime/tests/p5-native-source-identity.test.mjs`: selects `mingw64\bin\git.exe` from `where` output in any order.
   - `runtime/tests/amd19-authorization.test.mjs`: route counts public 98, internal-host 5, retired 4, total 107; the `p6-activate` route exists only under the test-fault policy.
   - `runtime/tests/p6-build-e2e.test.mjs`: three-slot single-use workspace pool (`p5-slot`, `p5-slot-2`, `p5-slot-3`) so the A→B→C chain has a successor.

## Production artifacts

The full Node run rewrote the shared build outputs. `runtime/tests/tauri-host-proof-b.test.mjs` runs `npm run desktop:build` with `DESZO_TEST_FAULT_HOOKS=1`; that writes test-hook builds to `dist-runtime/` and `src-tauri/target/release/`, and nothing restores them. The current outputs at the end of the run were test-owned (`BUNDLED_TEST_FAULTS = true`; receipts `testFaultHooks: true`, build ID `build-a`). The Node run's result is still valid for the source snapshot, but its artifacts were not uniform while it ran.

I restored production artifacts with `env -u DESZO_TEST_FAULT_HOOKS DESZO_DESKTOP_BUILD_ID=p6-final-2026-11-05 npm run desktop:build` (09:55:01Z–09:58:00Z, exit 0 — [s7-desktop-build-production.log](evidence/2026-11-05-final-acceptance/s7-desktop-build-production.log)). Current state, and the comparison with the freeze manifest, are in [artifact-state.json](evidence/2026-11-05-final-acceptance/artifact-state.json):

| Artifact | Current SHA-256 (prefix) | Recorded (2026-11-05 manifest) | Status |
|---|---|---|---|
| Host `deszo-lifecycle-host.exe` | `9b910e59…` | `9b910e59…` | Matches |
| Engine runner `dist-runtime/runner.mjs` | `e613e385…` | `e613e385…` | Matches (production, `BUNDLED_TEST_FAULTS = false`) |
| Bridge `dist-runtime/bridge.mjs` | `ff2b9842…` | `ff2b9842…` | Matches |
| `dist-runtime/host.mjs` | `e53b1445…` | `e53b1445…` | Matches |
| Shell `deszo.exe` | `ee711807…` | `5fcf8437…` | **Differs** |
| Launch shim, `src-tauri/target/release/` | `0e7ca42b…` | `27f7d83d…` | **Differs** |
| Launch shim, `dist-runtime/` | `675e47b9…` | `932347c5…` | **Differs** |

- Restored receipts: `src-tauri/target/release/deszo-build.json` has `testFaultHooks: false`, `desktopBuildId: p6-final-2026-11-05`; `dist-runtime/runtime-manifest.json` has `testFaultHooks: false`. No `.deszo-test-fault-hooks` marker exists in `dist-runtime/`.
- The two shim copies already differed in the recorded manifest (`27f7…` vs `9323…`). `scripts/build-shim.mjs --release` copies the built shim into `dist-runtime`, so both copies should match after `desktop:build`; they do not.

## Open items before release review

1. **Harness defect.** `tauri-host-proof-b` overwrites `dist-runtime/` and the shell binary with test-hook builds on every full Node run. Fix by building test artifacts into a separate directory, or by restoring production outputs at the end of the suite.
2. **Shell and shim provenance.** The restored shell and both shim copies do not match the recorded 2026-11-05 values. Establish whether the cause is the build ID, the link timestamp, or the pipeline, and reconcile the two shim copies.
3. **Independent review of the restructure.** The 2026-11-04 final security review predates the builder injection. This report's wiring checks were read-only verification by the author, not an independent review.
4. **Custody group crash (exit 4 at tests 31–34).** Not reproduced in the final run; cause not established.
5. **Retained test roots.** The Node run reported `some test roots could not be removed`. `.deszo/tests/.owners` lists retained roots from dead owners. They are test-owned and outside the freeze; not yet attributed to a specific run.

## Residual risks (recorded, not fixed here)

- `p6Builder.mjs` is outside the Engine's subject closure; coverage relies on the trusted-control tier checks.
- Test-fault routes live in source and are active in debug and source runs by design.
- Settling routes skip `assertAdmissionOpen`; this predates the P6 work.
- The `--p6-maintenance` path has not been reviewed.
- Not claimed: general production filesystem confinement, large-workspace availability, and any live-model behavior.

## Owner commit notes

- Nothing committed or pushed. `HEAD` is `1f54c47`. Uncommitted changes are intact.
- `runtime/core/testFaultPolicy.mjs` must be committed together with the modules that import it.
- `runtime/core/p6Consumer.mjs` and `runtime/core/p6Builder.mjs` are untracked and must be added.
- `docs/reviews/evidence/` is excluded from the freeze; decide whether these evidence files are committed.

## Evidence index

- Logs and manifests: [docs/reviews/evidence/2026-11-05-final-acceptance/](evidence/2026-11-05-final-acceptance/)
- Genuine E2E evidence: [docs/reviews/evidence/2026-11-05-genuine-e2e-run/](evidence/2026-11-05-genuine-e2e-run/)
- Freeze manifest: [docs/reviews/evidence/2026-11-05-p6-final-snapshot-manifest.json](evidence/2026-11-05-p6-final-snapshot-manifest.json)
- Restructure diff: [docs/reviews/evidence/2026-11-05-p6-consumer-builder-injection.diff](evidence/2026-11-05-p6-consumer-builder-injection.diff)
- Artifact state: [docs/reviews/evidence/2026-11-05-final-acceptance/artifact-state.json](evidence/2026-11-05-final-acceptance/artifact-state.json)
