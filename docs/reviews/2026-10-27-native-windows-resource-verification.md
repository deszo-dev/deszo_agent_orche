# Native Windows Resource Lifecycle Verification

**Date:** 2026-10-27  
**Branch:** `codex/adr-0003-0005-completion`  
**Base HEAD:** `3357fb08db5fcb2049d37dd54d9781b6a3b7d528`

## Final verdict

`RESOURCE LIFECYCLE VERIFIED WITH LIMITATIONS`

The original Branch Delivery cancellation gap was reproduced through the actual managed-task runner path, corrected, and covered by a Windows integration regression. The corrected candidate passed the complete Node suite, native Rust tests, docs validation, and build. A remaining non-atomic path check-to-delete race and two unexplained failures from earlier full runs prevent an unqualified “both closed” claim.

## Candidate identity and Git state

The four files present before this verification retained their recorded historical SHA-256 values. Three files were changed only after the production integration defect was reproduced:

| Verified worktree file | SHA-256 |
|---|---|
| `runtime/core/branchDelivery.mjs` | `8F329CF82FA31B1FFA3E9C57F9C2583642123A0869CBB59467283DBDF856097E` |
| `runtime/host/authority.mjs` | `0E27C4DF11A7D63C83A777714E2A1E6488CEF4CC7084529B1492EDDB37CF43C9` |
| `runtime/tests/adr6-regressions.test.mjs` | `6A7F9AE383C47FF31D0988D5A6727A01DCB83EA7192771298AA1EEE0DD6CCE0D` |
| `runtime/tests/branch-delivery.test.mjs` | `03D92984DDDB55C9B8C0A53C69EF2DD9B96475CFF65F0FE4317028E7D5463CB8` |
| `runtime/core/processes.mjs` | `D09D71860A11EF4D9459AC7561DAF681583A44AEF7B65B1282216B294989DFF0` |
| `runtime/core/taskProcesses.mjs` | `5B119E9C78E52AC04704A942C8A22F314C148B2BEAA697F6217B7A67E0349F5A` |
| `runtime/tests/managed-task.test.mjs` | `0F854985C6DF918BE93FD538A333E08F5F6E9E13196B628A34A86092BDCF7C53` |

The checkout remains on the stated branch and base HEAD. Seven tracked files are modified; there are no staged changes. Two other untracked review documents were left untouched. No stage, commit, push, merge, rebase, reset, `git clean`, or global temporary-directory cleanup was performed. This report is an additional untracked file.

## Native Windows environment and capabilities

| Component | Observed value |
|---|---|
| OS | Windows 11 Home Single Language, build 26300, x64 |
| Filesystem | NTFS on `C:` |
| Node / npm | Node 22.20.0 / npm 9.6.5 |
| Rust / Cargo | rustc 1.97.1 / Cargo 1.97.0 |
| Git for Windows | 2.39.2.windows.1 |
| Test inventory | 78 files: 3 heavy, 32 integration, 43 quick; tier check clean |

Local Git init, commit, clone, fetch, and upload-pack succeeded in a disposable repository. Git for Windows executed an extensionless `pre-commit` hook with fixture mode `100666`. Nested filesystem operations, atomic replacement, and a real junction succeeded. A held `FileShare.None` file refused deletion with `EBUSY`; deletion succeeded after release. A native `taskkill /T /F` probe stopped its test-owned parent/child tree. SQLite files and their fixture directory could be removed immediately after close. Native Job Object, Rust fixture, symlink-refusal, and junction-containment probes passed. No public remote or global Git configuration change was used.

## Leak A — Branch Delivery temporary Git hooks

### Defect reproduction

The original candidate’s low-level Branch Delivery tests passed, but the first independent review found they bypassed the production `TaskRuntime -> runTaskCommand` bridge. I reproduced the gap through a real managed `verified_branch` workflow in `supervised:false` headless mode. I intercepted only the actual `git clone` utility invocation to run a test-owned parent/descendant fixture; the real TaskRuntime, Branch Delivery runner path, and `core.hooksPath` argument remained in use.

The parent started a detached Node descendant that polled the allocated hooks directory. A private invalid `taskkill.exe` made the production termination request fail when I aborted the actual utility signal. The parent exited while its detached descendant remained alive. Branch Delivery then removed the hooks directory; the descendant observed `ENOENT` and wrote a marker. This reproduced premature cleanup in the production call path, rather than inferring it from a unit-level mock. I stopped the exact test-owned descendant with the absolute Windows system `taskkill.exe` and cleaned its owned fixture afterward.

### Correction and regression

Only after reproduction, I changed the process termination result flow. `killTree` now reports confirmation or error and checks the Windows `taskkill` exit status. `runTaskCommand` deduplicates and awaits termination when `waitForTermination` is requested, then returns `processActive` or `terminationError` when termination is uncertain. Branch Delivery already preserves the hooks directory when either signal is present.

The new Windows-only managed-task integration test repeats the real path with a detached consumer and a failing private `taskkill.exe`. It asserts that delivery stops, cleanup is deferred with a taskkill diagnostic, the hooks directory remains available while the descendant is alive, and the descendant does not observe a vanished directory. Test cleanup kills the exact fixture PID before removing its owned path. The new test passed 1/1 alone, and the managed-task suite passed 21/21.

The full Branch Delivery suite passed 20/20, including successful delivery, Git failure, early return, concurrent deliveries, pre-cleanup path substitution, and cancellation. The native Git hook probe confirmed hook execution. Final inventory found 161 `deszo-empty-hooks-*` directories and zero `deszo-hooks-*` directories; this matches the recorded count before the corrected full run, with no installed-hook directory remaining.

### Remaining path race

The existing allocation identity check detects a replacement made before cleanup validation. It is not atomic with recursive removal: a concurrent path swap between the final identity check and `rmSync` remains possible. The test suite covers substitution before validation, not this check-to-delete interval. The independent reviewer retained this as a limitation; it was not redesigned in this verification.

## Leak B — ControlHost SQLite construction and disposal

The selected assurance and shutdown cases passed 3/3. They cover refusal before SQLite acquisition, an assurance mismatch after acquisition, normal close, and idempotent repeated close. The mismatch fixture was removed in the same test process after the constructor failed, and the original exception remained observable. The complete corrected Node run also covered initialization failure, HTTP-listen failure, ownership-lock release, stale-owner handling, and normal shutdown. The post-run artifact registry reported zero active owners.

## Focused regressions

| Suite or selector | Result |
|---|---:|
| New managed delivery / failed-termination regression | 1/1 |
| `runtime/tests/managed-task.test.mjs` | 21/21 |
| `runtime/tests/branch-delivery.test.mjs` | 20/20 |
| `runtime/tests/process-custody.test.mjs` | 19/19 |
| Selected ControlHost assurance and normal-close cases | 3/3 |
| Engine Stop, timeout, and restart-recovery selectors | 3/3 |
| Loop restart-recovery selector | 1/1 |
| `runtime/tests/adr6-native-job.test.mjs` | 4/4 |
| `runtime/tests/f7-detached-maintenance.test.mjs` | 2/2 |
| `runtime/tests/test-roots.test.mjs` | 5/5 |
| Rust Host Proof A selector | 1/1; two fresh installs completed |

## Full regression and other gates

Three serialized full Node runs on the original candidate occurred before the reproduced defect was corrected. Runs 1 and 2 each had one failure; run 3 passed 859/859. Those earlier failure records remain preserved and their causes are unknown:

| Original-candidate run | Result |
|---|---|
| 1 | 858/859; F7-06 Race A reported `TypeError: fetch failed` during local HTTP workspace registration. Record retained at `.deszo/tests/failures/2026-10-27T15-03-19-607Z-custody-delivery.test.mjs-…/failure.json`. Three exact isolated reruns and original-candidate run 3 passed; transport cause remains unknown. |
| 2 | 858/859; Rust Host Proof A timed out waiting for the Build B connection descriptor. Record retained at `.deszo/tests/failures/2026-10-27T16-23-23-128Z-rust-host-lifecycle.test.mjs-…/failure.json`. Its exact isolated selector and original-candidate run 3 passed; timeout cause remains unknown. |
| 3 | 859/859, 0 failed, 0 cancelled; TAP completed, exit code 0; 2,561,652.9 ms. |

The complete Node suite was rerun after the correction on the verified worktree candidate:

| Corrected-candidate run | Result |
|---|---|
| Final | **860/860 passed**, 0 failed, 0 cancelled; TAP complete; 3,159,900.5 ms. The new Windows integration regression and native Tauri Proof B restart/repair cases passed. |

Other corrected-candidate gates:

- `cargo test --manifest-path lifecycle-host/Cargo.toml`: 23 passed, 0 failed; binary and doc-test targets completed.
- `npm run docs:check`: 0 errors; 32 schemas, 142 Markdown files, 1,259 local links, 17 Mermaid diagrams, and SQL/schema cases validated.
- `npm run build`: passed; Vite emitted its advisory for the 691.67 kB JavaScript bundle.
- `git diff --check`: passed with no whitespace errors; Git printed LF-to-CRLF working-copy notices for modified files.

## Artifact inventory and attribution

- Artifact registry after the corrected run: zero active owners; 18 retained failure directories, 55 files, 3,036,199 bytes. This includes the two earlier full-run records; no new cleanup-failure record was found.
- Current temporary hooks inventory: 161 `deszo-empty-hooks-*`, zero `deszo-hooks-*`. No hooks directory from the verification remained installed.
- Existing unowned `.deszo/tests` evidence, caches, and user/historical temp entries were preserved. No global cleanup was run.
- No test-owned descendant from the reproduction remained alive after cleanup. The only matching Node processes in the final process query were the Codex tool’s own Node REPL workers; no project test runner, Rust Host, or test fixture process remained.

## Independent read-only review

The requested reviewer first identified the production integration blocker before correction. After the fix, the same reviewer performed a read-only follow-up without editing files or running tests. It confirmed that `TaskRuntime -> runTaskCommand` now honors `waitForTermination`, deduplicates and awaits the termination request, reports `processActive` or `terminationError`, and reaches Branch Delivery’s preservation decision. It found the new regression relevant to that real path and recommended the limited verdict because the path check-to-delete race remains.

