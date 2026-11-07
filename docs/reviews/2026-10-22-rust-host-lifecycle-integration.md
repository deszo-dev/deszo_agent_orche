# Rust Lifecycle Host integration evidence — 2026-10-22

## Verdict

**PASS — Real Host lifecycle verified (Proof A).** A compiled Rust Host process owned an isolated install/profile, replaced the managed runtime with a staged candidate, remained alive while the Engine process changed, delivered a durable correlated lifecycle receipt, and the new Engine autonomously completed Repair and resumed Parent in two fresh installations.

**Proof B — packaged Tauri application: UNVERIFIED.** The supported desktop build succeeded, but the Rust Host is not wired into the Tauri packaged bootstrap. Proof A must not be read as evidence of packaged desktop replacement.

## Initial gap map

| Capability | Existing implementation at inspection | Required change / result |
|---|---|---|
| Rust Host executable | No independent Lifecycle Host executable was present in the runtime/package path. | Added `lifecycle-host`, a compiled Rust CLI over a UI-independent core. |
| UI-independent Host core | Tauri's Rust backend supervised its Node runner; no standalone lifecycle core existed. | `Host::start`, lifecycle state, activation, shutdown, and receipt handling run without a window. The CLI calls this same core. |
| Exclusive install/profile ownership | Tauri contained its own runner; legacy Control Host could also own a configured profile. | Added OS file locking by canonical install/profile identity, stale-lock release by the OS, and scoped legacy-owner refusal. |
| Actual Deszo bootstrap | Tauri launches Node `runtime/runner.mjs`; Engine is in that Node process. The desktop build bundles runtime resources and a native launch shim. | Proof A launches the production `runtime/runner.mjs` and Engine directly. The Host does not yet launch Tauri; Proof B remains unverified. |
| Candidate staging | No Host-owned staging/activation path existed. | Added allowed staging-root checks, build manifest checks, content hashing, version copy, and an atomic active pointer/generation update. |
| Typed lifecycle IPC | Lifecycle receipt handling existed in Engine, but was guarded by the Engine's first-party HTTP route. | Added a loopback-only Rust Host channel with a 256-bit capability and narrow `engine.ready`, `lifecycle.activate_candidate`, and receipt-ack commands. |
| Judge authorization handoff | Engine had a linked Repair/Judge proposal contract. | Engine validates the designated Judge node and linked candidate/checkpoint, persists intent, then forwards only that validated request to Host. |
| Managed shutdown | Tauri supervised its own runner/process tree; there was no Host-controlled replacement lifecycle. | Host requests controlled runner shutdown, waits, escalates within its owned Windows Job Object, and verifies the process tree is empty. |
| Candidate activation | No lifecycle candidate activation implementation existed. | Host verifies staging identity and digest, copies the candidate to its installed version path, atomically updates active build/generation, then launches it. |
| New Engine readiness | Engine had a runtime identity handshake; Host had no lifecycle readiness protocol. | Host accepts an authenticated readiness report only from the currently managed child and checks profile/store/build/generation identities. |
| Durable lifecycle receipt | Engine receipt route existed; independent Host receipt persistence/delivery did not. | Host persists operation phases and receipt before delivery, replays until acknowledged, and logs a durable acknowledgement. |
| Engine receipt reconciliation | Engine-native continuation was implemented and had focused coverage. | Kept the continuation mechanism; added only Host bootstrap delivery and strict Host-receipt validation. |
| Autonomous continuation integration | Engine-native Repair → Parent continuation tests existed. | Real Host + real Engine integration now verifies receipt consumption, Repair completion, and Parent resumption without harness scheduling. |

The inspection confirmed the working tree already contained continuation and migration work from the preceding task. ADR-0008 and ADR-0009 remain **Proposed**.

## Existing application architecture and Proof A process tree

The packaged desktop architecture in this repository is Tauri/Rust with a React UI. Tauri launches `node runtime/runner.mjs` as a child; the production Engine and its HTTP API run in that Node process, rather than as a separate Engine executable. The Engine launches provider CLI children, which can launch descendants. The Tauri backend's Windows Job Object is its existing containment boundary. The desktop runtime resources are copied into `dist-runtime` and mapped to `runtime/` by `src-tauri/tauri.conf.json`.

The Engine creates its first-party runtime token in `runtime/runner.mjs`. The new Host does not receive or use that token. The Host's Proof A child is the production runner/Engine, and the test provider implementation is deterministic local fixture code. The profile and SQLite store are selected from the test's isolated profile root; Host records the same Engine store identity before and after activation.

Proof A process tree exercised:

```text
deszo-lifecycle-host.exe (independent Rust process)
└── node runtime/runner.mjs (production Engine in this process)
    └── fixture provider CLI
        └── fixture descendant (provider-tree negative case)
```

Proof A uses the supported non-GUI runtime entrypoint. It is real Engine and Host code, not a Node Host simulator. It is not the packaged Tauri bootstrap.

## Host core, ownership, and candidate activation

`lifecycle-host` contains the lifecycle logic independently of a graphical UI. Its `run --config` entrypoint and `digest-candidate --path` command execute the same Rust library core used for the Host lifecycle. A future Dioxus surface can call that core; no Dioxus UI was built as part of this lifecycle proof.

Host canonicalizes install, profile, and staging roots, then obtains an exclusive `fs2` OS file lock keyed by the canonical installation/profile identity. Kernel lock release allows startup after process crash; ownership is not inferred from a PID file. On Windows it checks whether the existing legacy named-pipe Control Host owns the requested profile tree and refuses overlapping ownership. It does not refuse an unrelated isolated profile just because a legacy service is present.

The Host accepts only the defined activation operation. It does not accept a model-authored executable path or shell command. It verifies the candidate is under the configured staging root, checks the build manifest and required runtime files, rejects symlinks/unsupported files, and calculates SHA-256 over sorted relative paths and file contents. It rechecks candidate identity/digest before activation. The candidate is installed as a separate version and `active.json` changes atomically with a new generation.

The Windows Host creates a Job Object with kill-on-close for its managed application process tree. It first sends the runner's bounded shutdown command and waits; if shutdown is unresponsive it terminates only that owned Job Object. It confirms that the tree has emptied before activation/replacement. The provider-tree negative test demonstrates termination of both an active provider CLI and its still-running child, followed by Engine recovery marking the uncertain attempt interrupted rather than replaying it.

## Engine authorization, IPC, and receipt

Only the production Engine can originate a lifecycle request on the Host channel. A random 32-byte capability authenticates the local loopback connection. The Engine bootstrap values are read and removed from its environment before provider CLI launch. Each request is also bound to installation, profile, current generation, operation/run/node IDs, candidate ID/digest, and required readiness conditions. The Host rejects an unauthenticated client and concurrent owner.

The Judge is not trusted by a caller-supplied role string. The Engine checks the saved linked Repair workflow's designated Judge node, proposal action, candidate digest, and continuation checkpoint. Developer and Watcher proposals fail in the Engine before an operation is committed or delivered. After that validation, an internal Engine event sends the typed request through the authenticated Host channel. The Host trusts only that channel and the Engine's validated evidence.

The Host journal and durable state include operation identity, request fingerprint, phase, build/generation transitions, readiness, receipt, and acknowledgement. They do not include the Engine's first-party token or the Host capability. The lifecycle receipt binds operation ID, candidate ID and digest, installation/profile, previous and activated generation, Engine PID, store ID, actual activation, application responsiveness, and Engine readiness. The new Engine checks those values against its saved operation, current PID, current store, and bootstrap generation before recording a Host receipt artifact. The first-party HTTP lifecycle receipt route is refused for a Host-bound Engine.

Host keeps an unacknowledged receipt durable and returns the same receipt on retry. Engine application of the same receipt is idempotent. Host marks it acknowledged only after the new Engine applies it. A mismatch or missing receipt leaves Repair and Parent at their lifecycle gate.

For isolated fixture setup only, the Host test configuration forwards the initial runner startup descriptor directly to the test harness; the Host does not parse or store the first-party credential in it. No credential value is written into this report. The lifecycle Host protocol itself uses the narrow capability, not the Owner Token or first-party token. Provider execution in these tests uses local fixture adapters; no paid provider is invoked.

## Real lifecycle execution trace

The compiled Rust Host integration test ran the primary lifecycle twice from fresh temporary install/profile roots. In each iteration, the production Engine created the Parent and linked Repair workflows, the designated Judge generated the normal proposal, and Engine validation committed the intent. Once Host accepted the request, the harness performed GET-only observation; it did not activate the candidate, insert a receipt, or schedule continuation.

| Run | Host PID | Engine A → Engine B PIDs | Build A → B | Operation ID | Candidate digest | Receipt ID | Parent run → Repair run | Final states |
|---|---:|---|---|---|---|---|---|---|
| 1 | 29504 | 22672 → 5464 | `build-a` → `build-b` | `2f179c6f-a4a0-44ff-ae2d-6af8ddd7b4db` | `6f64906a3f1389faccc8519d65121eda6b498fefe9331be722f65d361c658731` | `41725b5d-e7de-43e6-9eb2-ac279a0f85b0` | `e8fcd5f1-74fb-4f41-b25a-9bfc9817986b` → `487aef55-dce5-42c4-9bea-f0dacaa881f8` | Parent succeeded; Repair succeeded |
| 2 | 11520 | 17984 → 612 | `build-a` → `build-b` | `4fbe65ae-b2fb-4f90-9b2e-0878a3f62c59` | `91497e9586158a25b723a16c0f3df634165d582bfa14450b9050755ec6349ba8` | `2c01d2b0-dda0-4fc9-9fc7-7ac8ea68eb48` | `0edf4abf-acbd-4803-88ec-d028decb8a75` → `2fb112f0-d584-4802-9fc0-1e9bcbe0bb54` | Parent succeeded; Repair succeeded |

Within each row, the Host PID was unchanged while the Engine PID changed. The new Engine reopened the same profile/store identity. The Host state and journal recorded, in order: `host_started`, `application_spawned` (`build-a`), `engine_ready`, `activation_accepted`, `shutdown_requested`, `managed_process_tree_stopped`, `old_process_stopped`, `candidate_activated` (`build-b` and candidate digest), `application_spawned` (`build-b`), `engine_ready`, a retry returning the same unacknowledged receipt, and `receipt_acknowledged`.

`build-a` and `build-b` are isolated runtime builds with distinct build-manifest identities and complete-tree digests. The Host activated the staged `build-b` directory and changed its active pointer/generation. The runtime source payload is the repository's production runtime; this does not represent a rebuilt or packaged Tauri binary.

On the new Engine, the verified receipt released the Repair gate. Engine completed the remaining Repair work and resumed Parent at its suspended node. Each committed Developer operation occurred once; Parent continuation was journaled once. Both workflows reached `succeeded` without a harness continuation call.

Machine-readable primary-run evidence is written by the test at `.deszo/tests/rust-host-proof-a-runs.json` (gitignored runtime test output).

## HOST-01 through HOST-20

| ID | Result | Executable evidence |
|---|---|---|
| HOST-01 | PASS — Proof A | `rust-host-lifecycle.test.mjs` builds and spawns the compiled `deszo-lifecycle-host` binary; Host journal and actual lifecycle effects are inspected. |
| HOST-02 | PASS — Proof A | Both primary runs assert the original Host PID remains alive across Engine A → Engine B. |
| HOST-03 | PASS | Primary test starts a competing compiled Host for the same canonical installation/profile; it exits with the ownership refusal before spawning another Engine. Lock release is also covered after Host crash/restart. |
| HOST-04 | PASS | Primary test sends an unauthenticated local IPC command and observes refusal; the lifecycle request and readiness/receipt travel over the capability-authenticated Host channel. |
| HOST-05 | PASS — Proof A | Real Engine validates the designated Judge's saved workflow role, linked candidate and checkpoint, persists intent, and delivers through its internal Host bridge. No harness Judge row or request is inserted. |
| HOST-06 | PASS | Engine negative tests show Developer and Watcher lifecycle proposals fail with `lifecycle_unauthorized`, create no lifecycle operation, and leave Parent held. |
| HOST-07 | PASS — Proof A | Rust digest command hashes the staged tree; Host verifies build identity/digest before activation. Primary receipt and journal carry the exact digest; mismatch case refuses before activation. |
| HOST-08 | PASS — Proof A | Host logs controlled shutdown and `managed_process_tree_stopped`; old Engine PID is no longer active before candidate launch. |
| HOST-09 | PASS — Proof A | Host copies staged `build-b` to the active version and updates the active pointer/generation. Both build identity and digest are observed independently in state and receipt. |
| HOST-10 | PASS — Proof A; Proof B UNVERIFIED | Host starts the production Node runner bootstrap. The test does not start a packaged Tauri application. |
| HOST-11 | PASS — Proof A | New Engine readiness contains its PID/build/profile/generation/store identity; the same SQLite store ID is observed after restart. |
| HOST-12 | PASS — Proof A | New Engine accepts only the Host receipt matching operation, candidate, digest, install/profile, generations, current Engine PID, store ID and readiness; test asserts no credential in receipt/journal. |
| HOST-13 | PASS — Proof A | After Host receipt delivery, Engine independently releases the lifecycle gate and completes Repair. |
| HOST-14 | PASS — Proof A | Repair completion causes Engine to resume and complete Parent; test performs observation only after Host acceptance. |
| HOST-15 | PASS — Proof A | Primary assertions count one committed Developer operation per Parent/Repair despite the Engine restart. |
| HOST-16 | PASS — Proof A | Host retries the same unacknowledged receipt twice; Engine treats replay as idempotent. One candidate activation and one Parent-resumed event are asserted. Wrong candidate receipts are refused. |
| HOST-17 | PASS — Proof A | Parent and Repair use separate isolated workspaces; primary assertion confirms no queued/running/waiting/stopping runs remain in either after completion. Provider-tree shutdown starts no replacement while the provider is live. |
| HOST-18 | PASS | All Host lifecycle workflows use deterministic fixture providers; the active provider-tree case uses a local slow fixture. No paid provider is invoked. |
| HOST-19 | PASS | Every integration scenario creates temporary installation, profile, store, staging, workspace, and Host records beneath a fresh temp root and removes it afterward. |
| HOST-20 | PASS | The actual compiled Rust Host executable owns the lock, launches/reaps real Engine processes, activates files, writes journal/state, and issues the receipt. No Node Host simulator is used. |

## Negative scenarios

| Scenario | Result and evidence |
|---|---|
| Unauthorized local lifecycle request | Refused because the request lacks the Host capability; no lifecycle operation is activated. |
| Developer / Watcher proposal | Engine rejects each with `lifecycle_unauthorized`; no operation is committed and Parent stays held. |
| Stale/mismatched staged candidate | Build manifest identity mismatch is refused; no `activation_accepted`, `candidate_activated`, or receipt is recorded; original Engine remains live. |
| Concurrent Hosts | Second compiled Host fails acquisition for the same canonical installation/profile and never spawns an Engine. |
| Host crash after shutdown intent | Host is killed after durable `shutdown_requested`; new Host reconciles the operation as failed without replay, retains build A, creates no receipt, and leaves workflows gated. |
| Candidate launches but Engine readiness fails | Host activates distinct build B, observes the candidate runner exit before readiness, marks operation failed, creates no success receipt, and leaves Repair/Parent held. |
| Engine restart with missing receipt | Recovery leaves Repair and Parent at the lifecycle gate; no final Repair work or Parent resume occurs. |
| Duplicate lifecycle receipt | Same durable Host receipt is returned twice before acknowledgement and applied twice by the Engine bridge; activation and continuation remain single. |
| Surviving provider process | Graceful Host shutdown terminates the active fixture CLI and its child; next Engine marks the attempt interrupted and does not retry it. |
| Wrong candidate receipt | Engine returns `lifecycle_candidate_mismatch` and keeps the gate until a matching result is delivered. |

## Verification commands and results

| Command | Result |
|---|---|
| `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/rust-host-lifecycle.test.mjs` | PASS, 5 top-level tests; primary Proof A runs against two fresh installs. |
| `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/workflow-continuation-strict.test.mjs runtime/tests/workflow-continuation-negative.test.mjs runtime/tests/workflow-continuation.test.mjs` | PASS, 13 tests. |
| `npm test` | PASS, 656 tests, 0 failed, 0 skipped; exit 0. |
| `cargo check --manifest-path src-tauri/Cargo.toml` | PASS, exit 0. |
| `npm run desktop:build` | PASS, exit 0. Builds runtime bundle, release launch shim, frontend, and `src-tauri/target/release/deszo.exe`; command uses `tauri build --no-bundle`. The build emitted a large JavaScript chunk warning and a Tauri bundle-identifier advisory. |
| `cargo fmt --manifest-path lifecycle-host/Cargo.toml -- --check` | PASS. |
| `cargo test --manifest-path lifecycle-host/Cargo.toml` | PASS, 5 Rust unit tests. |
| `cargo clippy --manifest-path lifecycle-host/Cargo.toml --all-targets -- -D warnings` | PASS. |
| `cargo build --manifest-path lifecycle-host/Cargo.toml --bin deszo-lifecycle-host` | PASS; the integration suite also builds and executes this binary. |
| `cargo build --release --manifest-path lifecycle-host/Cargo.toml --bin deszo-lifecycle-host` | PASS, optimized Windows executable compiled. |
| `npm run docs:check` | PASS; 124 Markdown files and 1,137 local links checked, 0 errors. |

## Proof A and Proof B

**Proof A: PASS.** It exercises the actual compiled Rust Host, production Node runner/Engine, production Judge validation, production Engine-to-Host bridge, real staged file activation, real OS processes, durable receipt delivery, and autonomous workflow continuation. The Host PID stays alive across the managed Engine replacement in both fresh installations.

**Proof B: UNVERIFIED.** `npm run desktop:build` compiles the desktop executable, but it invokes `tauri build --no-bundle`, and the package resources/bootstrap do not include or invoke `lifecycle-host`. The Host currently takes a Node executable and `runtime/runner.mjs` runtime configuration; it has no Tauri executable bootstrap, installable packaged-candidate contract, or packaged-profile lifecycle integration test. Therefore no packaged Tauri application was launched, activated, or resumed by this Host. The build result is not evidence of Proof B.

## Remaining limitations

- Current executable lifecycle verification is Windows-only. The code has Unix process-group and file-lock adapters, but those platforms were not compiled or exercised here.
- The Rust Host has a headless CLI and UI-independent core; a Dioxus desktop surface is not implemented.
- Proof A uses the real production Engine with local fixture provider CLIs and distinct runtime build manifests/digests. It does not rebuild the runtime source between A and B and does not replace a packaged Tauri binary.
- Tauri desktop executable compilation succeeded, but `--no-bundle` does not produce an installer or prove Host-managed desktop activation.
- The Host test's private first-runtime setup descriptor is intentionally exposed only to the test harness for fixture setup. It is not logged or written into Host state, and no receipt contains the first-party credential.

## Final evidence-backed verdict

**PASS — Real Host lifecycle verified (Proof A).** The Rust Host survived two real managed Engine replacements, activated a staged candidate, authenticated and correlated its result, and the new Engine autonomously completed Repair and Parent. **Proof B remains unverified** because the Host is not integrated with the packaged Tauri bootstrap.
