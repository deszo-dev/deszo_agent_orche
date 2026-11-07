# Real Tauri Lifecycle Host integration — Proof B (2026-10-23)

## Verdict

**PASS — Desktop Proof B verified on Windows.** The compiled Rust Lifecycle Host launched the real Tauri Build A, accepted a production Engine Judge lifecycle proposal, stopped the managed desktop process tree, activated a digest-verified different Tauri build, launched Build B, delivered its durable receipt to Engine B, and left the existing Engine-native continuation to finish Repair and Parent. The full desktop proof passed twice against fresh isolated installations. The full `npm test` run passed all 661 reported tests.

The proof exercised the repository's release `--no-bundle` desktop executable and its bundled runtime resources. It did not build or test an installer. The test-only Tauri config overlay enables an ephemeral WebView2 DevTools endpoint so the harness can use the real app UI before lifecycle acceptance; after Host acceptance the harness only observes.

## Baseline and actual desktop bootstrap

The preserved [Proof A report](2026-10-22-rust-host-lifecycle-integration.md) demonstrated Host → Node runner → Engine and explicitly left Host → Tauri → Node → Engine unverified. Inspection of `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, the runtime bundler, and `lifecycle-host` confirmed the desktop bootstrap:

```text
Rust Lifecycle Host
└── Tauri Deszo application
    └── Node runtime/runner.mjs (production Engine and API)
        └── provider CLI and descendants
```

Tauri selects packaged `runtime/` resources, resolves Node and the native launch shim, starts `runtime/runner.mjs`, and owns the Engine process lifecycle. The Engine owns workflow and provider execution. Before this change, the lifecycle Host accepted the headless runtime entrypoint and did not launch the Tauri executable.

The implementation preserves that division of responsibility. Host observes, shuts down, activates and restarts the Tauri process. Tauri continues to start and own Node/Engine. Engine continues to reconcile linked Repair and resume Parent.

## Windows process containment

Host assigns the Tauri process to its kill-on-close Windows Job Object. Tauri retains its existing kill-on-close Job for Node and its provider descendants. Neither Job enables breakaway; Tauri's Job has no UI restrictions. On current Windows, the actual integration run successfully assigned Tauri under Host and Node under Tauri, then drained the full subtree. Both real provider PIDs were dead before the replacement Engine proceeded, while an unrelated sibling process remained alive.

This parent/child Job relationship is supported by Windows nested jobs, introduced in Windows 8 / Windows Server 2012. Microsoft documents both nested Job hierarchies and termination through child Jobs: [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). The proof validates the configuration on this Windows environment; it does not claim compatibility with older Windows releases that do not support nested Jobs.

## Installation ownership and candidate verification

For desktop bootstrap, Host locking is keyed to canonical installation identity, not installation/profile pairs. The lock covers the shared active generation and activation pointer. Profile-specific storage and SQLite databases remain selected by the separate profile root. A competing Host configured with Profile B while Profile A owns the same installation is rejected before it starts an Engine. Proof B asserts the two stores are distinct in isolated profiles and verifies same-profile store continuity through restart.

The Host verifies the candidate remains under its configured staging root, checks the Tauri executable and required `runtime/` resources, checks runtime API/build identity and runtime-resource manifest, and hashes the full candidate. Activation occurs only after Tauri A and its managed tree have stopped. The Host then copies and rehashes the candidate into `versions/build-b`, updates the durable generation, and launches the executable from that installed version path.

## Production changes

- `lifecycle-host/src/lib.rs`: Tauri desktop candidate validation, executable/resource resolution, `--host-managed` startup, private bootstrap transfer, application identity/readiness checks, installation-wide desktop ownership, durable receipt validation, unexpected-exit handling, and Host-owned Tauri containment. An explicitly supplied `WEBVIEW2_USER_DATA_FOLDER` gets a per-build subdirectory; the variable is absent during normal launches, so the regular WebView2 profile behavior is unchanged.
- `src-tauri/src/main.rs` and `src-tauri/build.rs`: accept the Host-managed bootstrap over Tauri's piped stdin, bind the actual Tauri PID and compiled build identity into Engine readiness, and pass the narrow lifecycle capability to the Engine through the existing runner bootstrap.
- `runtime/host/lifecycleBridge.mjs`, `runtime/runner.mjs`, and `runtime/core/linkedRepair.mjs`: include application PID/build identity in readiness and require the authentic receipt to match the persisted operation, candidate, installation/profile, prior and activated generations, application/Engine/store identities, and readiness state. Existing Engine continuation logic remains the mechanism that resumes Repair and Parent.
- `scripts/tauri-build.mjs` and `package.json`: keep the normal `npm run desktop:build` pipeline while allowing the proof harness to supply its temporary Tauri config overlay.
- `runtime/tests/tauri-host-proof-b.test.mjs` and `runtime/tests/fixtures/proofb-cli.rs`: launch the compiled Host, real release Tauri processes and production Engine processes using deterministic local fixture providers. The test uses temporary installations, profiles, workspaces, WebView2 data roots, and `CODEX_HOME`.

No Dioxus UI, second lifecycle manager, workflow scheduler, continuation endpoint, paid provider, installer, or installed-user application/profile was used. ADR-0008/P31 and ADR-0009/P32 remain in their existing Proposed state; this implementation task did not silently accept the proposals.

## Build identity and desktop artifacts

The integration helper ran `npm run desktop:build` twice, setting `DESZO_DESKTOP_BUILD_ID` to `build-a` and `build-b`. Each command used the repository pipeline: bundle runtime resources, build the native launch shim and frontend, then invoke Tauri `build --no-bundle`. A temporary config overlay added only WebView2 arguments for local UI control. The proof package contains the actual release `deszo.exe`, the matching production `runtime/` directory (including the launch shim and runtime manifest), and the Host candidate manifest. The compiled desktop build marker and full package digest are both checked.

| Build | Tauri executable SHA-256 | Complete candidate SHA-256 |
|---|---|---|
| Build A (`build-a`) | `4301fc9202a49ead9b4b90a943b2af296b301e56df6e92d54109cbb3ea425ffa` | `fe80e4275fde9a43d0bcc1bea71d52890b8c99092e7f5f735ed18f1e09561e5b` |
| Build B (`build-b`) | `aa76593076ab890863cc2082858fa53d5d40cc5c6a8eaed8fe4d1c556ea390cc` | `e13049ff8a75b711818ca9610e8464b3a15ab2d8a13d6122d66592d5f1c087a5` |

The Tauri executable hashes differ, as do package digests. Candidate digest equals the Build B package digest in both runs. Build B was launched from the installed `versions/build-b/deszo.exe` path after Host recorded the new generation; this was an actual process launch, not an `active.json` label change.

## Credential and lifecycle IPC boundaries

Host passes only the desktop bootstrap fields and its narrow lifecycle capability to Tauri through the piped stdin connected to `--host-managed`; secrets are not placed in the Tauri command line, candidate manifest, or Host journal. Tauri retains its existing first-party runtime-token arrangement. It passes Host lifecycle fields to the Node runner via the private runner environment, and the lifecycle bridge consumes/deletes those values before user workflow/provider execution. The first-party Engine token is not given to Host and appears in neither the Host journal nor the durable receipt. The integration test also checks that the Host capability does not reach the fixture provider environment.

The Host channel is loopback-only and capability-authenticated. Engine accepts readiness only from the managed Tauri PID/build and correlates the durable Host receipt with the saved lifecycle operation before unlocking continuation. Duplicate readiness/receipt delivery returns the same receipt and is applied idempotently.

## Two fresh-installation process traces

The raw Host event streams, Judge authorization data, durable receipts, and process/run IDs are preserved in [the Proof B execution evidence](evidence/2026-10-23-desktop-host-proof-b.json). Both iterations ran on Windows. `hostPid` remains constant within each row while Tauri and Engine PIDs change. `storeId` remains constant through that row's restart.

| Iteration | Host PID | Tauri A → B PIDs | Engine A → B PIDs | Installation / store | Activated generation | Operation / receipt | Repair / Parent |
|---|---:|---|---|---|---|---|---|
| 1 | 24260 | 31144 → 32340 | 7236 → 32984 | `314c2cfc72222a30f022f382b0a37816` / `6d735e80-a98a-46c3-9e78-90a96a5d7618` | `c3e20b4b-4f45-44dc-81eb-d1beeb947014` | `ad3bc154-4e9f-453b-ac58-4cfc04dd72bd` / `692a8569-c4b5-4a6a-bbd6-dd86b38ff554` | `d5e87fd6-3eee-4ac6-bb9e-1d3f3bd4aa65` / `b3b81a7c-ef43-4d53-afec-652239deda83` — succeeded / succeeded |
| 2 | 28592 | 26856 → 16396 | 30364 → 25060 | `ed247128bc6ecf73c1a386f41492a419` / `04e7c89e-511b-478e-b719-04b3b24f0690` | `4ceb9ec1-284f-4298-a1be-39b3d902caa6` | `8a01e41a-b769-44fc-8cc6-dd87d678de8d` / `d54882dd-c4e9-4fa2-9570-0a015ca9751e` | `609e0461-ad9e-404e-8b92-f234ae171b19` / `e560005f-1e92-4a76-bee5-1d3af5b00088` — succeeded / succeeded |

Judge authorization IDs are preserved in the same evidence file: iteration 1 uses Judge attempt `1ecb1869-2fe3-4292-a850-19296e9b425e` and proposal artifact `48a3da26-589d-4aa4-bf00-1ab0aff5db70`; iteration 2 uses attempt `01bc7fb4-ee26-48ce-bdf2-4510fec6a42b` and artifact `f94de001-5021-43ed-81f8-aba80728a3f4`. Both proposals target `build-b` and the verified Build B digest.

Each trace has this component-owned chronology:

1. Host acquires the isolated installation lock and launches Tauri A with `--host-managed`; Tauri starts Engine A, whose authenticated readiness reports the Tauri PID, `build-a`, runtime instance and store.
2. Through the actual Engine API, Parent performs committed work and suspends for linked repair. Repair runs its Developer and Watcher and reaches its designated Judge. Production Engine validation records a `LifecycleProposal` for `application.activate_candidate`; the Host accepts that authenticated operation.
3. Host requests managed shutdown, confirms `managed_process_tree_stopped` for Tauri A and Engine A, and observes the active fixture provider CLI and descendant terminate.
4. Host verifies/copies candidate B, writes the activated generation, and launches `versions/build-b/deszo.exe`. Tauri B starts Engine B. Engine B reports the expected build and the same store.
5. Host sends the durable receipt; duplicate `engine.ready` delivery reports the same receipt ID. Engine acknowledges it once, validates the persisted operation, and autonomously resumes Repair then Parent. The harness observes their terminal `succeeded` states using read-only queries.

In both runs, the receipt records `actualActivation`, `applicationResponsive`, and `engineReady` as true and binds operation, candidate digest, installation/profile, previous/activated generation, application PID/build, Engine PID/runtime instance, Host PID, and store ID. Each run records one candidate activation, one lifecycle verification and one Parent-resumed event. Committed Parent/Repair Developer attempts remain at exactly one each. A concurrently active side-workspace run is recovered as `interrupted`; no conflicting active Parent/Repair run remains.

## Acceptance assertions

Each row is backed by the raw execution trace above and the executable assertions in the [Proof B integration test](../../runtime/tests/tauri-host-proof-b.test.mjs). DESKTOP-16 also links to the Engine-native [strict continuation tests](../../runtime/tests/workflow-continuation-strict.test.mjs).

| ID | Result | Executable evidence |
|---|---|---|
| DESKTOP-01 | PASS | Test builds/runs the independent Rust Host executable; both Host PIDs and `host_started` events are in the JSON evidence. |
| DESKTOP-02 | PASS | `application_spawned` records Build A executable path and `bootstrap: tauri`. |
| DESKTOP-03 | PASS | Build A `engine_ready` reports a distinct Engine PID under Tauri A. |
| DESKTOP-04 | PASS | Build A/B executable SHA-256 and complete package digests differ. |
| DESKTOP-05 | PASS | Stored `LifecycleProposal` references the successful designated Judge attempt and artifact in both iterations. |
| DESKTOP-06 | PASS | Authenticated Host journal contains `activation_accepted` for each Judge operation. |
| DESKTOP-07 | PASS | Host records shutdown/tree-stopped events; test asserts provider CLI and descendant are dead while an unrelated sibling remains alive. |
| DESKTOP-08 | PASS | Host records one `candidate_activated` event per fresh installation with the verified Build B digest and new generation. |
| DESKTOP-09 | PASS | Host launches the actual `versions/build-b/deszo.exe`; Build B readiness confirms it. |
| DESKTOP-10 | PASS | Host PID stays unchanged across A/B; Tauri and Engine PIDs differ in each trace. |
| DESKTOP-11 | PASS | Engine B reports `build-b` and the same `storeId` as Engine A. |
| DESKTOP-12 | PASS | Durable Host receipt appears in Engine B readiness and receives `receipt_acknowledged`; fields match the live processes and store. |
| DESKTOP-13 | PASS | Engine B's read-only run observation shows Repair `succeeded`. |
| DESKTOP-14 | PASS | Engine B's read-only run observation shows Parent `succeeded` after Repair. |
| DESKTOP-15 | PASS | Integration asserts one committed Developer attempt per Parent/Repair, one lifecycle verification and one Parent-resumed event. |
| DESKTOP-16 | PASS | Proof B leaves no conflicting active Parent/Repair runs; `workflow-continuation-strict.test.mjs` separately verifies a suspended Parent and Repair each block a second run in their own workspace. |
| DESKTOP-17 | PASS | The negative competitor Host using Profile B is refused while Profile A owns the same installation; it starts no Profile B Engine. |
| DESKTOP-18 | PASS | Host deliberately redelivers the same authentic receipt; one activation and one continuation are asserted. |
| DESKTOP-19 | PASS | Active fixture provider and child PIDs are verified dead after Host shuts down Tauri A. |
| DESKTOP-20 | PASS | All proof installations/profiles, `CODEX_HOME`, staging and workspaces are temporary under `.deszo/tests`; no installed/user profile is selected or modified. |

## Negative tests

| Case | Result |
|---|---|
| A — Two profiles share one installation | PASS. Profile B Host receives “another lifecycle Host already owns this desktop installation”; no second Engine starts. |
| B — Incomplete desktop candidate | PASS. Missing launch shim/resource is rejected before shutdown; Build A stays active and no receipt is produced. |
| C — Build B Engine bootstrap fails | PASS. Candidate has a valid recomputed resource manifest/digest, so Host activates and launches B; runner fails before readiness; there is no success receipt and Repair/Parent remain at the lifecycle gate. |
| D — Incorrect build identity | PASS. Build A executable cannot satisfy the Build B identity in its manifest; Host exits nonzero before readiness and does not create an operation or receipt. |
| E — Invalid receipt | PASS. Existing Engine negative continuation test sends a receipt for another candidate; Engine returns `lifecycle_candidate_mismatch` and holds the gate until the matching result. The Proof B success receipt additionally asserts all persisted operation/generation/store/process bindings. |
| F — Duplicate receipt | PASS. The same authentic Host receipt is delivered twice through readiness; receipt ID is unchanged, with one activation and one continuation. |
| G — Provider descendant during shutdown | PASS. A deterministic local CLI and child are active at shutdown and neither survives into B. |
| H — Unexpected Tauri exit | PASS. Before any authorized activation, the test terminates Tauri A; Host records `managed_application_exited_unexpectedly`, drains Engine A, exits nonzero and records no activation or receipt. |

## Verification commands and results

| Command / activity | Result |
|---|---|
| `npm run desktop:build` with `DESZO_DESKTOP_BUILD_ID=build-a` and the temporary proof overlay | PASS, exit 0; log `.deszo/tests/desktop-host-proof-b-artifacts/desktop-a-build.log`. |
| `npm run desktop:build` with `DESZO_DESKTOP_BUILD_ID=build-b` and the temporary proof overlay | PASS, exit 0; log `.deszo/tests/desktop-host-proof-b-artifacts/desktop-b-build.log`. |
| `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/tauri-host-proof-b.test.mjs` with artifact reuse and retention enabled | PASS, 5 top-level Proof B tests, including two fresh installation runs; exit 0. |
| `npm test` | PASS, 661 passed, 0 failed/skipped; exit 0. Full TAP saved locally at `.deszo/tests/npm-test-proof-b-final.tap.log`. |
| `npm run docs:check` | PASS, exit 0; 30 schemas, 141 positive schema cases, 82 negative schema cases, 42 negative semantic cases, 125 Markdown files and 1,141 local links, with 0 errors. |
| `cargo test --manifest-path lifecycle-host/Cargo.toml` | PASS, 5 Rust Host unit tests; exit 0. |
| `cargo clippy --manifest-path lifecycle-host/Cargo.toml --all-targets -- -D warnings` | PASS; exit 0. |
| `cargo fmt --manifest-path lifecycle-host/Cargo.toml -- --check` | PASS; exit 0. |
| `cargo build --manifest-path lifecycle-host/Cargo.toml --bin deszo-lifecycle-host` | PASS; exit 0. |
| `cargo test --manifest-path src-tauri/Cargo.toml --bin deszo` | PASS, 13 tests; exit 0. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --bin deszo -- -D warnings` | PASS; exit 0. |
| `cargo check --manifest-path src-tauri/Cargo.toml --bin deszo` | PASS; exit 0. |
| `git diff --check` | PASS; exit 0. |

The file-wide `rustfmt --check --edition 2021 --config skip_children=true src-tauri/src/main.rs` returned 1 because the existing large Tauri source file has broad formatting differences beyond this localized change. I did not reformat the whole file and introduce unrelated churn. The lifecycle-host crate formatting check and both crates' Clippy checks pass.

## Remaining limits

- The proof is Windows/WebView2-specific and was executed in the available interactive Windows desktop session. The Tauri overlay used for UI control is temporary and not the shipping configuration.
- The real Tauri executable and runtime resources were built and activated with `--no-bundle`; no MSI, NSIS, or other installer/package lifecycle was built or tested.
- A future Dioxus UI was not built; the Host remains an independently runnable CLI/core.
- The receipt negative test exercises the wrong-candidate mismatch; success-path assertions check the remaining receipt bindings. This proof does not separately inject every possible malformed generation/store/operation combination.
- `src-tauri/src/main.rs` file-wide rustfmt cleanliness remains unverified because of the pre-existing whole-file formatting mismatch noted above.

## Final result

**PASS — The real Rust Host replaced a real Tauri desktop Build A with a different real Tauri Build B twice, kept the same Host process alive for each restart, delivered an authentic Host receipt to the newly started production Engine, and Engine B autonomously completed Repair and resumed Parent. All DESKTOP-01 through DESKTOP-20 assertions passed, all targeted negatives passed, and the full `npm test` suite passed.**
