# Deszo — Test Infrastructure Performance and Artifact Lifecycle

**Date:** 2026-10-27
**Branch:** codex/adr-0003-0005-completion (base 6655b30, uncommitted)
**Scope:** test infrastructure only. No production orchestration, Process Custody, recovery, Parent/Repair or runner.lock code changed.
**Verdict:** TEST INFRASTRUCTURE VERIFIED WITH LIMITATIONS (section 9)

## 1. Baseline (measured from `evidence/2026-10-27-p3-clean-final-npm-test.tap.log`)

847 tests, `duration_ms` 2,941,878. The sum of top-level test durations is 2,882 s, so per-file process startup and hooks account for about 60 s; setup work happens inside test bodies. Test-to-file attribution is by name match (282 of 838 names were attributed by file order).

| Category | Files | Tests | Time | Share |
|---|---:|---:|---:|---:|
| Custody / real Host and Engine processes | 12 | 97 | 1,166 s | 40.5% |
| Other in-process Engine integration | 11 | 150 | 520 s | 18.1% |
| Tauri Proof B (`tauri-host-proof-b`) | 1 | 8 | 427 s | 14.8% |
| P1/P2/P3 workflow recovery | 9 | 63 | 274 s | 9.5% |
| F7 Git maintenance (`f7-detached-maintenance`) | 1 | 2 | 194 s | 6.7% |
| Quick tier (40 files) | 40 | 517 | 188 s | 6.5% |
| Control-host exploration | 1 | 1 | 112 s | 3.9% |

Root costs found by measuring the expensive setup steps individually:

| Rank | Test / setup operation | Time | Root cost | Action |
|---|---|---:|---|---|
| 1 | Proof B: two `npm run desktop:build` release builds | 133 s each (P3 artifact timestamps) | Build A and Build B differ in their compiled identity, so every run recompiled the `deszo` crate twice | Verified package cache (3.3) |
| 2 | F7: `git hash-object -w --stdin-paths` over 9,000 files | 89–100 s per test (measured) | Per-file Git cost on Windows, not fsync (`core.fsync=none` and `batch` made no difference) | Loose objects written directly (3.4) |
| 3 | F7: clone + commit next to 9,000 loose objects | 28–37 s per test | The clone copied the objects, and its commit ran `gc --auto` | Clone taken before the objects exist |
| 4 | Custody fixture `rustc -O custody-cli.rs` in each of 18 test processes | 4.9 s each, about 85 s in total | Rebuilt per process into one shared `codex.exe` (also the LNK1104 cause) | Content-addressed build (3.2) |
| 5 | Fixed real-time waits in Custody tests | about 145 s in source | Proofs across production thresholds (for example a 35 s outage that must exceed 30 s) | Kept (section 8) |
| 6 | Exploration: 2,401 × (mkdtemp, SQLite copy, Host open) | 112 s | Isolated state per sequence, by design | Kept; per-sequence cleanup added |

## 2. Artifact inventory (before)

| Artifact family | Root | Entries | Size | Ownership | Retention before | Policy now |
|---|---|---:|---:|---|---|---|
| `root-*` runner roots (`startTestRunner`) | `.deszo/tests` | 17,625 | ≈21.4 GB (sampled) | test | never removed | A: removed per test |
| Other per-test roots (m1-store, gate, mcp-*, spool, …) | `.deszo/tests` | ≈2,200 | ≈1.5 GB | test | never removed | A |
| Proof B installations from failed runs | `.deszo/tests` | 20 | ≈1.7 GB | test | removed only on success | A + failure diagnostics |
| Total `.deszo/tests` (robocopy) | | 19,847 | 30.3 GB, 2.16 M files, 1.46 M dirs | | | |
| `deszo-explore-*` | `%TEMP%` | 24,010 | ≈5.4 GB | test | never removed | A: removed per sequence |
| Other ADR6/host temp roots | `%TEMP%` | ≈8,500 | ≈2.3 GB | test | never removed | A |
| `deszo-empty-hooks-*` | `%TEMP%` | 130+ | ≈0 | **production** (`runtime/core/branchDelivery.mjs:247`) | never removed | out of scope; reported |
| Cargo targets | `lifecycle-host/target`, `src-tauri/target` | | 0.8 GB, 7.6 GB | build | kept | B: kept (Cargo validates) |
| Custody / Proof B fixtures, desktop packages | `.deszo/tests/custody-artifacts`, `desktop-host-proof-b-artifacts` | | <0.1 GB | build | rebuilt every process/run | B: digest-verified reuse |
| Proof JSON (`tauri-*.json`, `rust-host-proof-a-runs.json`, runner-lock / custody evidence) | `.deszo/tests` | ≈10 | small | test evidence | overwritten per run | C: never recorded, never removed |
| `docs/reviews/evidence/**` | repo | | | reviewed evidence | committed | C: outside every approved base |
| Manual logs, pilots, operator, acceptance (`.deszo/*` outside `tests`) | `.deszo` | | ≈1 GB | user / unknown | | D: never touched |

One P3-era full run (measured by creation time inside its 49-minute window) left 258 directories / 24,642 files / 403 MB in `.deszo/tests` and 2,619 directories / 3,483 files / 588 MB in `%TEMP%`: **≈991 MB per run**.

## 3. Changes

### 3.1 Test-owned roots (`runtime/tests/test-roots.mjs`)
- `ownedDir(prefix)` replaces `mkdtempSync(join(base, prefix))`. `ownedPath(path)` covers a fresh UUID path that the code under test creates. `adoptRoot(path)` covers a root reported back by a child script the test started. All three accept only a direct child of `.deszo/tests` or `os.tmpdir()`.
- **Owner registry and lock:** only in a `node --test` file process. Each root is recorded in `.deszo/tests/.owners/<pid>-<uuid>/roots.jsonl`. The owner holds an exclusive SQLite lock (`owner.sqlite`, the same OS mechanism as runner.lock but a separate file) for its whole life.
- **Teardown** (top-level `afterEach`):
  1. Run the root's stoppers (`startTestRunner`'s `close`).
  2. End tracked child processes still alive (`startCustodyHost`, `startEngine`, the Proof B Host). `taskkill /T` is used only on an unreaped child of this process.
  3. On failure, copy bounded diagnostics.
  4. Verify the root, then remove it.
  `{ scope: 'file' }` keeps a fixture for later tests in the same file (`adr6-native-job`'s compiled `jobguard.exe`).
- **Verification before any removal:** an absolute path; a direct child of an approved base (by realpath); not the base itself; `lstat` is a directory and not a link or junction; realpath equals the path. Node's recursive rm unlinks a junction inside a root without following it (proven in TR-05). Windows sharing failures are retried for about 5.5 s, then reported and recorded as `remove_failed`.
- **Failure diagnostics** go to `.deszo/tests/failures/<time>-<file>-<test>`. They contain `failure.json` (test, error, root listing, child PIDs and exit codes) and copies of text files (≤256 KiB tail each) and SQLite files (≤16 MiB). Copies are capped at 48 MiB and 400 files in total. `.git`, `node_modules`, WebView2, `versions`, `staging` and binaries are skipped. The newest 20 diagnostics are kept.
- `DESZO_TEST_KEEP_FAILED=1` retains the complete failing root, which reconciliation then skips.
- `DESZO_PROOFB_KEEP_ARTIFACTS=1` still keeps Proof B installations; they are not owned in that mode.

### 3.2 Build reuse (`runtime/tests/build-cache.mjs`)
- **Rust fixtures (`custody-cli.rs`, `proofb-cli.rs`):**
  - Built into `<artifacts>/<sha256(source, rustc -vV, flags)[:24]>/codex.exe`, via a private file renamed into place.
  - Reused only if `build.json` names the same key and the executable digest still matches.
  - This removes 17 of 18 compilations per run. An executable in use is never overwritten, which was the shared-path LNK1104 cause.
- **Rust Host:** unchanged. `cargo build` (≈0.8 s when current) keeps deciding validity.
- **Proof B desktop packages:**
  - **Key:** every `git ls-files --cached --others --exclude-standard` file except `*.test.mjs` and `docs/reviews/**`, plus `node_modules/.package-lock.json`, the overlay, the build id, Node, `rustc -vV`, `cargo -V`, platform/arch and `CARGO_*`/`RUST*`/`TAURI_*` variables.
  - **Reuse:** only after the executable SHA-256 and the Host's `digest-candidate` of the package both match the record. The record lives beside the package, so it is outside the digest.
  - **Recording:** a build is recorded only if the key is unchanged after the build. This was observed working: an edit made during the cold run's Build A left A unrecorded.
  - **Assertions kept:** A≠B executable and package digests are still asserted on every run. Every run records the cache outcome in `tauri-host-proof-b-runs.json`.
  - **Replaced shortcut:** the old unvalidated `DESZO_PROOFB_REUSE_DESKTOP_ARTIFACTS` path is gone.
  - **Opt-out:** `DESZO_TEST_REBUILD_DESKTOP=1` always rebuilds.

### 3.3 Expensive fixtures
- **F7 (`f7-detached-maintenance.test.mjs`):**
  - The source still receives 9,000 random loose blobs. They are now written directly in Git's loose format, 16 at a time.
  - Git verifies them: `cat-file --batch-check` reads each one as a blob, and `count-objects` counts at least 9,000.
  - The clone is taken before the objects exist; the clone needs only the shared base.
  - The control (default fetch starts maintenance) and the production fetch are unchanged.
  - Survivor attribution now uses Git's subcommand (plus `worktree prune`, `rerere gc`, `reflog expire`). The old word match counted another application's `git diff -- f7-detached-maintenance.test.mjs` (the Codex desktop app polling this repository) as maintenance, and failed 2 of 4 runs after the file was edited. An unparseable command line still falls back to the old word match.
- **Exploration:** all 2,401 sequences, same depth and invariants. Each sequence's root is released immediately; a worker-thread variant saved 6 s and was dropped.
- **Wiring:** 37 test files and two helpers are wired into owned roots. Assertions are unchanged.

### 3.4 Tiers and gate
- **Tiers** (`runtime/tests/tiers.json` + `scripts/run-tests.mjs`): `heavy` (3 files) and `integration` (32) are listed. Every other file is `quick` (43 files now, including the new `test-roots.test.mjs`), so a new file is never left out of a tier. `check` fails on a missing or doubly listed file.
- **`npm test`** passes the same `runtime/tests/*.test.mjs` pattern to `node --test --test-concurrency=1` as before.
- **Gate** (`.deszo/tests/.gate/gate.sqlite`, exclusive SQLite lock): taken by `full`, `integration` and `heavy`.
  - A second gated run exits 75 at once, naming the holder, and never stops it (verified).
  - The OS releases the lock however the holder ends.
  - Separate fixture paths alone do not prevent two runs from rebuilding `src-tauri/target/release/deszo.exe` under each other, which is why the gate is needed.
  - Not reused from production runner.lock.
- **Stale roots:** `scripts/test-artifacts.mjs` provides `status` and `reconcile`. Reconcile runs before each `npm test` and removes only roots recorded by a dead owner. Unrecorded directories (including the legacy ones) are only counted.

## 4. Before/after (measured)

| Measure | Before (P3 clean run) | After (frozen candidate) |
|---|---:|---:|
| `npm test` tests / pass | 847 / 847 | 852 / 852 (5 new cleanup proofs) |
| `npm test` `duration_ms` | 2,941,878 | 2,812,666 (wall 46 m 54 s) |
| F7 (2 tests) | 194 s | 21 s |
| Custody fixture compilations per run | 18 × ≈4.9 s | 1 |
| Proof B builds per run, cold cache | 2 (133 s each) | 2 (197 s and 187 s this machine/session) |
| Proof B builds per run, warm cache | 2 | 0 (both packages reused after digest re-verification) |
| Proof B desktop tests (10), cold → warm | — | 893 s → 161 s; first test 687 s → 51 s |
| Exploration | 112 s | 126 s (adds deletion of 2,401 roots, ≈540 MB) |
| Quick-tier files (P3 durations) | — | 188 s; `npm run test:quick` measured 5 m 27 s wall, 528/528 |
| Disposable residue per full run | ≈991 MB (2,877 dirs, 28,125 files) | 0 test roots after the follow-up rerun; 22 empty production `deszo-empty-hooks` dirs |

The full-run duration is 4.4% shorter, although both Proof B builds were cold in that run, because the candidate had changed since the cold-cache run. F7 accounts for most of the saving.

## 5. Safety evidence (`runtime/tests/test-roots.test.mjs`, real `node --test` child processes, scratch bases only)

| Proof | Result |
|---|---|
| TR-01/03/04 success removes the root; an unowned build cache and evidence file beside it remain; `docs/reviews/evidence` is outside every base | pass |
| TR-02 failure: root removed, `failure.json` + small logs + a 600 KB log's tail kept, 3 MB binary/exe/`versions` not copied; KEEP mode retains the root, reconcile skips it unless `--include-retained` | pass |
| TR-05 refuses base, nested, relative, outside and junction roots; a junction inside a root is unlinked, its target survives | pass |
| TR-06/08 a live tracked process's spool is refused; a SQLite file held open is retried for a bounded time, reported, kept; removal succeeds once released; TR-10 idempotent | pass |
| TR-07/09/10 a concurrent process's root survives another's cleanup; reconcile skips a live owner, then removes the hard-killed owner's root only; an unrecorded directory survives; second reconcile removes nothing | pass |

## 6. Test tiers

`npm run test:tiers` → 78 files: heavy 3, integration 32, quick 43, problems []. `npm test` still selects every file by the original pattern.

## 7. Independent review

A read-only reviewer found no Critical or High issues. Resolved:
- **M1 (desktop key):** `runtime/tests/fixture-adapters.mjs` is bundled into `dist-runtime`; test support modules are now key inputs.
- **M2 (desktop key):** `node_modules/.package-lock.json` added.
- **L1:** hook order documented in `test-roots.mjs`.
- **L4:** owner-lock `busy_timeout` added.
- **L5:** misleading fixture-install fallback removed.
- **L6:** gc child subcommands added to F7 attribution.
- **L8:** README wording corrected.

Accepted:
- **M3:** the gate only sees runs started through `scripts/run-tests.mjs`; documented in README.
- **L2:** a timed-out test's root is removed while its body may still run; the test has already failed.
- **L3:** reconcile may partly delete a dead owner's root still held by an orphaned grandchild; it never touches a live owner's root.
- **L7:** an inconsistent `tiers.json` stops `npm test` loudly instead of dropping a file.
- **L9:** theoretical PID reuse for descendants only, under `taskkill /T`.

## 8. Remaining costs and why they stay

- **Custody and Host suites (≈1,160 s):** real Rust Host, real Engine processes and real provider fixtures. They include about 145 s of fixed waits that prove behaviour across production thresholds. Shortening them would need test-only threshold overrides in production code; that is a separate decision.
- **Proof B on a cold cache (two release builds, ≈3–5 min):** inherent whenever any build input changes.
- **Exploration (≈126 s):** full 7⁴ state space with isolated SQLite per sequence.
- **Production leak, not fixed here:** `runtime/core/branchDelivery.mjs:247` creates `deszo-empty-hooks-*` in `%TEMP%` and never removes them (≈22 per run, empty).
- **Unclosed test store:** `ControlHost`'s constructor leaves its SQLite file open when it throws (`adr6-regressions` "Enablement" test). Each run reports one root that only reconciliation can remove.

## 9. Limitations and final verification

- **Legacy residue:** the ≈30 GB of legacy `.deszo/tests` roots and ≈8 GB of `%TEMP%` roots predate ownership records, so the reconciler does not remove them. `npm run test:artifacts -- status` counts them by family.
- **Final verification on the frozen candidate:** `npm test` 852/852, exit 0. `cargo test --manifest-path lifecycle-host/Cargo.toml` 23/23, exit 0. `npm run docs:check` exit 0. `npm run build` exit 0. `git diff --check` exit 0.
- **Changed after the full run:** three test files (`revisions`, `pipeline`, `branch-delivery`) were converted afterwards. They were rerun alone: 36/36, leaving no roots.
- **Warm Proof B run** on the frozen candidate: 10/10 pass, both packages reused.
