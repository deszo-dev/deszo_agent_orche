# Deszo — P6-G0 Minimal Host Compatibility & Safe Engine Switching

**Date:** 2026-10-31  
**Repository:** `C:\my\2026\deszo_agent_orche`  
**Platform:** Windows 11 Home Single Language  
**Purpose:** Implementation, native verification, recovery acceptance, and handoff record

## 1. Final verdict

**P6-G0 IMPLEMENTATION NOT VERIFIED**

The real Windows feasibility work and several useful Host/package foundations are present, and the current full regressions pass. The critical Engine-only switching path is absent: the compiled Tauri Shell still requires the Host-selected build ID to equal its compiled build ID, there is no Engine-only stage/switch API, and the existing `lifecycle.activate_candidate` route remains available. The Store guard is not connected to a production switch caller. No Shell-S-to-Engine-B switch was executed.

## 2. Starting and final Git state

- Branch: `codex/adr-0003-0005-completion`.
- HEAD at both start and finish: `1f54c47fe265c6b47bf36695be56214056fc3af1`.
- The worktree was already dirty when this review phase began. No reset, clean, stash, rebase, merge, commit, or push was performed.
- The final evidence snapshot contains 780 tracked and untracked, non-ignored project files. Its SHA-256 is `3eefd28b04432c6823f3a4b433536b36761269ef1c8191fa9c8e60ca8c8c8463`; the report file itself is excluded from this digest.
- Digest recipe: sort `git ls-files --cached --others --exclude-standard`; for each path append UTF-8 `path`, NUL, lowercase SHA-256 of file bytes, LF; hash the resulting bytes.
- `git diff --check` exited 0. Git printed only its configured LF-to-CRLF notices.

## 3. Existing Host capability inventory

The Rust Lifecycle Host already owns an installation lock, durable lifecycle state and journal, an active build selector, package and artifact verification, authenticated Engine IPC/readiness, native process ownership, Process Custody Jobs, and existing P5 release attestation. The current lifecycle activation path can replace a managed desktop release and recover its own operation state.

Those capabilities do not provide an Engine-only switch beneath one unchanged Tauri Shell. The active release and the compiled Shell build identity remain coupled. No G0 stage record, Engine switch record, or maintenance-preflight state exists.

## 4. Windows/SQLite feasibility experiment

Evidence: [P6-G0 feasibility JSON](evidence/2026-10-31-p6-g0-feasibility.json), captured on Windows 11 Home Single Language with Node `v22.20.0` and SQLite `3.50.4`. The Rust native helper was `lifecycle-host/examples/p6_g0_file_guard_probe.rs`, SHA-256 `79886965143762b48cdfa9e9adeec39e9067fd389f213a2863b4e7fa3a6cab30`.

The experiment used a real WAL database. A live read-only B connection could read it, but opening B changed `-shm`; a separate writer was still admitted during B preflight; and opening a WAL database with missing `-wal` or `-shm` created sidecars. A live checkpoint attempt failed with a disk I/O error. A successful read-only SQL session therefore did not establish a physical no-write boundary.

The native guard used `FILE_SHARE_READ`. While held, writes, deletes, and renames failed with Win32 sharing violation 32. An open A database connection prevented guard acquisition. Killing the Host released the handles; write and rename succeeded after release. The evidence also records stable file identities and that the production database hash stayed unchanged while the disposable copy was inspected.

The probe did not demonstrate a live Custody writer racing with a G0 switch because no G0 switch caller exists.

## 5. Selected Store-preflight implementation

Selected strategy: **`DISPOSABLE_COPY_REQUIRED`**.

The evidence supports stopping A, obtaining Host-owned guards on the stable production SQLite file set, copying the consistent Store into fresh Host-owned scratch, and running B maintenance preflight only against that disposable copy. If preflight fails before commit, the Host can release its guards and resume the exact A release. The experiment showed the production database hash stayed unchanged during scratch preflight, and A reopened and wrote after guard release.

`lifecycle-host/src/store_guard.rs` implements and tests a guarded-copy primitive. It is exported by the Host but has no production caller in a switch path. No maintenance Engine entrypoint, production preflight, or A fallback operation was implemented.

## 6. H-min-1 — Stable Shell and Engine identities

**Status: not implemented.** `src-tauri/src/main.rs:55–56` rejects bootstrap unless `application_build_id == COMPILED_DESKTOP_BUILD_ID`. The desktop packager still writes `desktopBuildId: buildId` in `scripts/desktop-release.mjs:104`.

The actual Tauri A-to-B proof below uses two desktop executables with different compiled build identities. It demonstrates full desktop replacement, not one byte-identical Shell launching a different Engine build.

## 7. H-min-2 — Exact Engine-only staging

**Status: not implemented.** Existing Host package verification checks managed desktop releases, and the existing activation machinery stages/replaces that release unit. There is no operation that stages a separately attested Engine package under an unchanged Shell while A remains active. No G0 stage ID, Engine-only package digest, or staged Engine artifact set was produced.

## 8. H-min-3 — Durable Engine switching

**Status: not implemented.** The Host has durable lifecycle operations and an installation-owned active build selector for its existing managed-release activation path. There is no G0 A/B switch identity, Engine-only authoritative selector, switch status API, or recovery logic that commits one Engine beneath an unchanged Shell.

No G0 switch operation ID, active Engine before/after pair, or switch receipt exists. P5 Engine replacement and Host restart tests exercise the existing lifecycle path and are not G0 switching evidence.

## 9. H-min-4 — Custody fencing and safe quiescence

**Status: not implemented in the switch path.** Existing Process Custody owns provider process trees, native Job containment, generation fencing, and termination evidence. The full Node and Rust suites exercise those capabilities, and packaged P5 tests prove Custody work can be retained across existing desktop replacement.

No G0 transition fences new Custody admissions, proves zero relevant Jobs, or holds the fence through an Engine switch. A successful existing Custody stop test cannot establish that missing transition boundary.

## 10. H-min-5 — Read-only preflight and precommit fallback

**Status: not implemented.** Windows evidence rules out treating a live read-only SQLite connection as a physical no-write boundary. The chosen disposable-copy method has an implemented native helper and Rust unit tests, but no production Engine B maintenance process uses it.

There is no Host-bound maintenance-ready receipt, no exact B preflight bound to process and staged package identity, no switch commit after preflight, and no one-shot bounded A fallback. No automatic Store restore was attempted.

## 11. H-min-6 — Legacy activation bypass closure

**Status: not implemented.** `runtime/host/lifecycleBridge.mjs:80` exposes `lifecycle.activate_candidate`. Rust dispatch still accepts that route in `lifecycle-host/src/lib.rs:1513`; `accept_operation` still accepts `application.activate_candidate` at lines 1906–1909. This is the current lifecycle mechanism, not a G0-enforced switch contract.

## 12. Protocol and schema changes

No G0 Engine-stage/switch protocol, maintenance-ready message, switch-status response, or authenticated activation receipt schema was added. No Store migration was added for G0. Existing activation request/receipt fields remain for the whole-release Host lifecycle path.

The build tooling now records `desktopBuildId`, runtime-manifest digest, and `testFaultHooks` in local build receipts. These fields protect packaging and stale-build reuse; they do not create a trusted Engine-switch protocol or an ADR-0006 build attestation.

## 13. Host/Tauri package layout

The current managed release layout keeps `deszo.exe`, runtime resources, P5 support payload, and `build.json` together under an installed `versions/<buildId>` release. The Host selects and verifies that whole package. There is no separate installed Shell root with multiple Engine roots or independent Engine selector.

No second Host or general-purpose updater was added.

## 14. Actual source and build identities

Final source: HEAD `1f54c47fe265c6b47bf36695be56214056fc3af1`; 780-file worktree digest `3eefd28b04432c6823f3a4b433536b36761269ef1c8191fa9c8e60ca8c8c8463`.

Native binaries and package evidence:

- Rust Host debug executable `lifecycle-host/target/debug/deszo-lifecycle-host.exe`: SHA-256 `8da54bae90f102649addc264fb1412df28ac7be3b48a4bd91fddc25e73d1aa7f`.
- The current `src-tauri/target/release/deszo.exe` is a **test-hook-enabled** Build A executable, SHA-256 `5900f3f40f371ef331c27ce8630176115f48ab06e253d1fa2952e07b00f08a61`. Its receipt says `testFaultHooks: true`; the release packager rejects it. It is not a production G0 artifact.
- The full-run P5 desktop package evidence records shell SHA-256 `b3dc09edf94c07d0c860aba0bf84a852dd92a83fdafae093c90ccd97095810f0`, Engine runner SHA-256 `76cd55309428abdb7a9e10a813d8a328d5901ba8be7436417a59f4c685f66dfb`, P5 support SHA-256 `abd34253543f0d3a42f5b946ac7d2014de19e31dc77ae9664f60b0f8f31404bf`, and package SHA-256 `44cc592b7581f68f17ad4865b81d75129a6aa2575c9e75bd53d0d6d86a097a0c`.
- G0 stage ID, switch ID, before/after Engine identity, and Store migration history: **none; no switch was executed**.

## 15. Native Windows process evidence

`Proof B` passed with the actual Rust Host and packaged Tauri runtime: the Host restarted Tauri A as Tauri B and P5 continued Parent/Repair twice. `Proof B with Process Custody` also passed with a live Custody-owned provider CLI and descendant across the Tauri A-to-B replacement. The tests ran on Windows and use real Host and desktop processes.

These tests prove the existing full desktop replacement path. They replace the Tauri Shell and do not prove Shell S launching an independently identified Engine B. The Windows file-sharing evidence is documented in Section 4.

## 16. G0-C01–C18 results

No crash-matrix operation was run because there is no G0 stage/switch endpoint or state machine to fault-inject. Existing P5/Host crash tests are not substituted for these cases.

| ID | Result |
|---|---|
| G0-C01 | Not run — no G0 stage operation |
| G0-C02 | Not run — no G0 stage operation |
| G0-C03 | Not run — no G0 stage receipt |
| G0-C04 | Not run — no G0 switch operation |
| G0-C05 | Not run — no switch Custody fence |
| G0-C06 | Not run — no switch quiescence state |
| G0-C07 | Not run — no B maintenance preflight |
| G0-C08 | Not run — no B preflight/fallback path |
| G0-C09 | Not run — no switch termination gate |
| G0-C10 | Not run — no precommit switch recovery |
| G0-C11 | Not run — no G0 selector commit |
| G0-C12 | Not run — no postcommit G0 recovery |
| G0-C13 | Not run — no G0 commit acknowledgement |
| G0-C14 | Not run — no B switch-transition process |
| G0-C15 | Not run — no bounded A fallback operation |
| G0-C16 | Not run — no switch Store identity check |
| G0-C17 | Not run — no concurrent G0 switch requests |
| G0-C18 | Not run — no repeated G0 switch recovery |

## 17. Dedicated graceful shutdown test

`P5-CLOSURE-GRACEFUL-CAPTURE` passed in the final full Node run (250,987 ms). A managed graceful shutdown during the candidate-capture Host await preserved the same Attempt and Custody evidence and recorded the handoff. This closes the dedicated P5 graceful-shutdown regression; it is not a G0 switch test.

## 18. Production fault-hook closure

The Engine fault policy is build-mode gated: test-owned bundles retain authorized test injection, while production bundles and shipped P5 support do not honor the ordinary environment triggers. Desktop build receipts bind the compiled build ID, executable digest, runtime-manifest digest, and hook mode. `desktop-release` rejects test-enabled receipts or runtime manifests; operator preparation and `inspectRuntimeBuild` now reject test-enabled runtime manifests and require the desktop receipt’s runtime-manifest digest to match before and after preparation.

Evidence: final full-suite tests `P6-G0 production bundles ignore environment fault hooks while source tests retain them` and `P6-G0 raw runtime and P5 support source close fault hooks in production packages` both passed. The fresh implementation reviewer rechecked the receipt and operator-preparation fix and found the earlier medium packaging finding closed.

## 19. P5 regression results

The final full run passed the packaged `P5-CLOSURE-DESKTOP` case, the uncertain-Custody-tree case, graceful capture shutdown, Host retry/failure/Stop boundaries, Judge reattachment, and P5-GIT-2. The packaged desktop closure test took 398,313 ms and recorded the P5 shell/runner/support/package hashes in Section 14. Existing P5 functionality remains covered on this source snapshot.

A prior development run had one transient publication fetch failure; the final-source full run completed that same desktop closure case successfully. The earlier result is not used as final-snapshot evidence.

## 20. Full Node regression

Command: `npm test`  
Runtime: Node `v22.20.0`  
Result: **968 passed, 0 failed, 0 canceled, 0 skipped; exit 0**. The runner reported 937 top-level suites and a total duration of 9,422,879.94 ms (about 2 h 37 min).

This run began after the last source edit and completed before the report was added. It includes the corrected desktop identity fixture and the operator runtime-manifest guard. The runner reported that some test roots could not be removed; their status is recorded in Section 27 and they were preserved.

## 21. Rust Lifecycle Host regression

Command: `cargo test --manifest-path lifecycle-host/Cargo.toml`  
Result: **33 passed, 0 failed; exit 0**. Rust unit tests include exact package verification, Custody generation/process behavior, guarded disposable Store copying, rollback-journal refusal, and sidecar drift detection.

## 22. Desktop package result

The final Node suite built and exercised real packaged Tauri releases through P5 `P5-CLOSURE-DESKTOP` and Rust Host Proof B. The P5 desktop package passed and its hashes are recorded in Section 14. The actual Tauri replacement proof passed.

No G0 Engine-only package was staged or packaged. The current direct Tauri target receipt is test-hook-enabled and the new provenance checks reject it as a production release. The verified P5 package is a regression artifact, not a G0 switching deliverable.

## 23. Independent review

A fresh-context, read-only implementation reviewer inspected the current source and test evidence. It confirmed that the stale test-built Shell cannot pass `desktop-release` as production, then found a separate operator-preparation gap: test-enabled runtime bundles could be accepted under an older production desktop receipt. That gap was fixed by rejecting `testFaultHooks !== false` in `inspectRuntimeBuild` and binding the runtime-manifest digest in `prepare`. The reviewer rechecked these changes and confirmed the packaging finding is closed.

The same reviewer found the G0 blockers remain: compiled Shell/Engine identity coupling, an accessible `lifecycle.activate_candidate` route, and no production caller for `guard_and_copy_store`. It confirmed there is no packaged Shell-S/Engine-B switch.

## 24. Remaining limitations and blockers

- The six H-min capabilities are not connected as a minimal Engine-only switch path.
- Tauri Shell and Engine identities remain coupled.
- Exact Engine-only staging, switch selection, durable recovery, and switch receipt are absent.
- Process Custody fencing is not connected to a switch transition.
- Live SQLite read-only preflight is unsafe as a physical no-write guarantee; the disposable-copy helper is not in production flow.
- Precommit fallback and legacy activation-bypass closure are absent.
- The test suite has no G0-C01–C18 switch operations to exercise.
- The P6-BUILD source pipeline remains intentionally unimplemented.

## 25. Separate Host deployment requirements

The Host and frozen Tauri Shell remain outside Self-Repair. Any future compatible Host/Shell infrastructure release must be built, reviewed, and installed through the ordinary maintainer deployment process. P5/P6 must not update the Host executable, Host trust/protocol boundary, Shell, or frozen native resources. This work did not produce or deploy a Host/Shell update to installed users.

## 26. P6-BUILD handoff contract

**Handoff is blocked.** P6-BUILD must not assume G0 readiness or invent a switch operation ID. Before handoff, G0 needs an unchanged Shell that can authenticate a different Engine identity, exact Engine-only staging, one durable Host-owned selector and switch state, a Custody admission fence, disposable-copy Store preflight bound to the exact B process/package, safe precommit A fallback, postcommit no-rollback behavior, and rejection of legacy activation bypasses.

Any later build handoff must bind candidate source/package identity and exact file digests, preserve Shell/Host/frozen resources, and return an authenticated durable activation receipt. It must not add owner approvals, a second updater, automatic SQLite migration, or postcommit automatic A fallback.

## 27. Final Git state

- Branch and HEAD are unchanged: `codex/adr-0003-0005-completion` at `1f54c47fe265c6b47bf36695be56214056fc3af1`.
- The final report is the only file added after the full test run; it is excluded from the 780-file source digest in Section 2.
- No commit, push, reset, clean, or test-artifact cleanup was performed.
- `node --disable-warning=ExperimentalWarning scripts/test-artifacts.mjs status` reported 18 retained diagnostic roots, 2,113 files, and 30,730,713 bytes. It also reported pre-existing unowned `.deszo/tests` and `%TEMP%` entries, including feasibility-probe scratch roots. All were preserved.
- Final checks: full Node suite 968/968; Rust Host 33/33; `npm run test:tiers` exit 0; `npm run docs:check` exit 0; `git diff --check` exit 0 with only Git line-ending notices.
