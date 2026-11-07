# P6-BUILD-UNBLOCK — Postcommit Engine Readiness and Verified Git Clone Integration

**Project:** Deszo Agent Orchestrator
**Stage:** P6-BUILD-UNBLOCK
**Architecture:** ADR-0010 — Minimal Autonomous Engine Self-Update
**Date:** 2026-11-03 (Europe/Moscow)
**Previous verdict:** `P6-BUILD REVIEW BLOCKED` ([continuity report](2026-11-03-p6-build-continuity.md))

## 1. Final verdict

**`P6-BUILD-UNBLOCK VERIFIED — READY FOR GENUINE P5 AUTONOMOUS E2E`**

- **Goal A (readiness): restored.** The readiness failure was not a Host, Shell or Engine defect. The packaged test's fixed 180 s wait expired at the commit, and its teardown stopped the Host mid-readiness; the Host's own graceful stop then removed the managed record while B was alive (§5–§7). With the harness wait corrected, the unchanged real Host commits B once, the same B process continues from maintenance into ordinary startup, resolves its Host-bound P5 continuation, sends genuine readiness, and the switch reaches `verified` (§10–§13). A graceful Host restart keeps B selected and replays its continuation without a second receipt (§20).
- **Goal B (Store-backed Git source): proven.** Inside the Host-selected Engine B, B's own production preparation path (`materializeProtectedSelfRepairPreparation` → `prepareP5WorkspaceFromIntent`) prepared a fresh managed clone from B's release-bound `verifiedLocalSource`. The enrolled origin cannot serve B, and only `refs/heads/main` was fetched. The clone checks out B's exact installed commit and tree, with complete ancestry and no publication (§14–§19).
- **Three production defects were found and fixed** on the way: P5 enrollment currency in P6 successors (Fix 1), the P5 package-layout gate (Fix 2) and the Gate dependency-closure contract (Fix 3). Before these fixes, P5 could not run at all in a P6 Engine (§7–§8).
- **Evidence:** the packaged synthetic P6/G0 test passes end to end on the exact final tree (runs 5 and 6, §22). The focused suites pass. The independent reviewer reports no unresolved Critical, High or contract-breaking Medium finding (§23).
- **Not claimed:** a genuine Developer/Gate/Judge acceptance, a genuine A→B→C chain, or a full regression. The packaged test's P5 inputs are synthetic, and the full Node regression was not run (§24–§25). Medium finding M1 (a Host commit-window race) stays open and non-blocking (§23).

## 2. Repository state

| Item | Start | Final |
| --- | --- | --- |
| Branch | `codex/adr-0003-0005-completion` | unchanged |
| HEAD | `1f54c47fe265c6b47bf36695be56214056fc3af1` | unchanged |
| Worktree | 32 modified, 64 untracked | 35 modified, 66 untracked (this stage: modified `runtime/core/p5Support.mjs`, `runtime/tests/protected-self-repair.test.mjs`, `runtime/tests/p5-desktop-layout.test.mjs`; further edits to already-modified `runtime/core/protectedSelfRepair.mjs` and `docs/schemas/protected-self-repair.schema.json` and to untracked `runtime/core/testEngineProbe.mjs`, `runtime/tests/p6-build-e2e.test.mjs`, `runtime/tests/p6-build-unit.test.mjs`; new: this report and its diagnosis evidence) |

The existing uncommitted P5/P6 work was preserved. No reset, clean, stash, rebase, merge, commit or push was performed. Every Git write targeted test-owned repositories under the ignored `.deszo/tests` root. No production installation, profile or remote was touched.

Tool resolution in the PowerShell environment used for every packaged run: `git` → `C:\Program Files\Git\cmd\git.exe` (P5 itself pins `mingw64\bin\git.exe` through the test's `actualGit()`), `tar` → `C:\Windows\system32\tar.exe`, Node `v22.20.0`. Packaged runs were launched through `cmd /d /s /c`, not Git Bash.

## 3. Starting source snapshot

The method of the continuity report (sorted `git ls-files --cached --others --exclude-standard`, hashing `path`, NUL, SHA-256 of the bytes and newline; ignored `.deszo` roots excluded):

- Excluding the continuity report, as it did: **829 paths, `9509eeff932bff164439edf0cacf04f1c57727c838c42bbb82ca2912f0686a03`** — identical to the recorded baseline.
- Including it: 830 paths, `bf98ddec3be82cdbeff3243279eff21998a42d87daeb2c55d7754b5c53c8cd86`.

## 4. Readiness failure reproduction

No new failing run was needed to reproduce the failure: the two failing packaged runs of the continuity pass were retained with their full Host state (`.deszo/tests/p6-build-e2e-6t3Zwi` and `.deszo/tests/p6-build-e2e-VoajN1`). Both fail identically. Their Host journals, durable `lifecycle.json`, `active.json`, `runner.log` and failure records were read; the structured record is [evidence/2026-11-03-p6-build-unblock-readiness-diagnosis.json](evidence/2026-11-03-p6-build-unblock-readiness-diagnosis.json).

Four earlier retained runs of the same day (`3Fd8Vy`, `6sggr4`, `O5w11q`, `j9CtHN`) reached `engine_switch_verified` 116–144 s after Engine A became ready; their failures were later C-fixture errors. The two failing runs needed 188–194 s to reach the commit: the continuity pass had added pre-switch source checks, and the two runs were started about 55 s apart and shared the machine.

## 5. Process, PID and Host timeline (run `6t3Zwi`)

All times are the Host journal's millisecond epoch `at` values from one Host clock (Host PID 12808).

| # | `at` | Event | Process facts |
| --- | --- | --- | --- |
| 1 | 1793698148959 | `engine_ready` (A) | Shell 30088, Engine 9208, generation `6f82a7b7…` |
| — | ≈149.2 s | Test posts the test-only `p6-activate` route and starts a fixed 180 000 ms `eventually()` | |
| 2 | 1793698287223 | `engine_staged` | B `engine-f50c8f655524`, package `3e6cc9dd…`, operation `e5e51d04-240c-46bb-90d8-26e822f15391` |
| 3 | 1793698306999 | `engine_switch_accepted` | |
| 4 | 1793698309413 | `managed_process_tree_stopped` (A) | Shell 30088 / Engine 9208 ended |
| 5 | 1793698317523 | `application_spawned` (B maintenance) | Shell 18776; `state.managed` inserted under the state lock (`lib.rs:1627-1646`) |
| 6 | 1793698320942 | `engine_preflight_passed` | Engine 36616, child of Shell 18776; `maintenance_ready` requires `state.managed` (`engine_switch.rs:522-531`) |
| 7 | 1793698321516 | `engine_store_boundary_verified` | the switch worker then finds the candidate alive (`engine_switch.rs:738-746`) and re-hashes the package for 15.5 s |
| 8 | between 321.5 s and 337.0 s (deadline ≈329.2 s) | Test timeout → `finally` → `host.stop()` | writes `shutdown` to Host stdin (`p6-g0-support.mjs:197-201`); `Host::run` breaks its loop, ends custody, calls `shutdown_managed()`, which takes `state.managed` (`lib.rs:863` → `2580-2584`) |
| 9 | 1793698337014 | `engine_switch_committed` | the worker thread writes `active.json` = B; it does not re-check the record or the stop request |
| 10 | 1793698337026 | `engine_switch_held` | `wait_for_candidate_ready` finds no record: "the candidate is not running" (`engine_switch.rs:886-907`); durable phase stays `committed` |
| 11 | 337.0–340.3 s | B ordinary startup | `engine.source_release` refused "Lifecycle Host has no managed application" (`lib.rs:1890`) → runner.log `source_release_unavailable` |
| 12 | 1793698340307 | `engine_readiness_refused` | same Engine 36616; `accept_ready` has no record (`lib.rs:2142-2152`); the unhandled refusal ends the runner |
| 13 | 1793698341169 | `managed_process_tree_stopped` (B) | logged at the end of the Host's own `shutdown_managed` (`lib.rs:2647`) |
| 14 | 1793698341211 | `host_stopped` | |

Run `VoajN1` (Host 35216, B `engine-d8b95b92dc5c`, operation `3561ad5a-…`) shows the same chain: commit at 194 s after Engine A readiness, `engine_switch_held` 10 ms later, B's tree stopped by the Host's shutdown 1.9 s later.

Answers to the M1 questions: `state.managed` was present after the maintenance spawn, at preflight success and at the pre-commit liveness check; it was removed before B's normal startup by the Host's graceful stop path, not by a candidate exit; B (pid 36616) was still alive 3.3 s after the removal; B made no running-source query before registration; the preflight and readiness came from the same process; no operation, build, generation or package identity changed; the synthetic package carried everything normal startup needs (run 1 below); and the process-record loss caused `source_release_unavailable`, after which the readiness refusal, not continuation, ended B.

## 6. First causal failure

The packaged test's fixed 180 s readiness wait (`p6-build-e2e.test.mjs`, measured from the trigger) was shorter than the real trigger-to-commit time under the conditions of those runs. Its timeout ran the test's `finally`, which stopped the Host while the switch worker was between its candidate check and readiness. Every later message — "the candidate is not running", "Host has no managed application", `source_release_unavailable`, "Host has no managed application process" — is a consequence of that test-initiated Host stop.

## 7. Root causes

Three independent defects stood between the stage's goals and their proof (the third was raised as H1 by the independent reviewer):

1. **Readiness (Goal A): test-harness deadline and teardown.** Not a Rust Host, Shell or Engine startup defect. `state.managed` was genuinely removed — by the Host's own graceful stop, which the test requested.
2. **Fresh B managed clone (Goal B): P5 enrollment currency in every P6 successor.** Found by the new fresh-clone step in packaged run 2, where Engine B's own production preparation refused with `p5_enrollment_changed`. `validateP5EnrollmentFile` (`protectedSelfRepair.mjs:137-172`) records `enrollmentDigest` as the digest of the continuation-resolved **effective** enrollment, but `verifyP5EnrollmentFileCurrent` (`protectedSelfRepair.mjs:318-339`) compared it with the digest of the **root** enrollment file on disk. After any P6 update those can never be equal, so every operation that re-checks enrollment currency — Parent admission (`engine.mjs:451`), the source-binding and P2 checks (`engine.mjs:518, 604`), Developer capture (`engine.mjs:795`), workspace preparation (`engine.mjs:991`) and the trusted Gate (`p5Gate.mjs:741`) — refused in B. B could load its continuation but could never run P5.
3. **P5 admission and Gate in every P6 Engine package** (reviewer findings H1 and H1b). `verifyP5PackageLayout` (`p5Support.mjs:58` before the fix) refused any packaged release whose bootstrap is not `tauri`. A P6 installation launches only `engine` packages beneath the Shell (`lib.rs:1506`), and continuation requires `engine` (`p6Continuation.mjs:95`, `p6GitObjectSource.mjs:49`). Admission (`engine.mjs:284`) and the trusted Gate (`p5Gate.mjs:748, 1123`) therefore refused in both A and B: every boot logged `runtime_package_layout(p5_package_layout_unsupported)`. The genuine autonomous E2E could not have started. The P5 support payload of the retained B package (`p6-build-e2e-6t3Zwi/.../engine-f50c8f655524/p5/p5-support.json`) already matched its Host-attested release in every field (build, commit, source and inputs digests), its reproducible bundle SHA matched `runtime/runner.mjs`, all 698 payload files matched and the trusted verifier was listed; only the bootstrap test refused it.

## 8. Production code fixes

**Fix 1 — enrollment currency**, in `runtime/core/protectedSelfRepair.mjs`:

- `validateP5EnrollmentFile` also returns `fileEnrollmentDigest`, the digest of the root enrollment as written in the installed file.
- `verifyP5EnrollmentFileCurrent` takes `fileEnrollmentDigest` (defaulting to `enrollmentDigest`, so root installs behave exactly as before) and the loaded `enrollment`. It verifies the installed file's bytes and native identity against `fileSha256` and `fileEnrollmentDigest`. For a root install it returns the file value as before. For a P6 successor it returns the loaded effective enrollment only if that enrollment's digest equals the recorded `enrollmentDigest`; otherwise it refuses with `p5_enrollment_unavailable`.

This implements ADR-0010 §9 as written: the reader "validates the immutable root enrollment file as written … and derives an effective enrollment". Every caller then re-runs `verifyP5GitBaselineCurrent` against the Host's current running-source release (`engine.mjs:451-457, 518-524, 604-611, 795-801, 991-996`; `p5Gate.mjs:741-749`), which refuses if the enrolled successor release differs from the Host's. The fix widens no authority: the root file must be byte-identical, and the effective enrollment is only the one this Engine resolved at startup from that file, the immutable Store chain and the Host's durable switch status.

Unit coverage (`runtime/tests/protected-self-repair.test.mjs:721-734`) shows the successor record is accepted, that the pre-fix comparison refuses it (`p5_enrollment_changed`, the reproduced defect), that a different in-memory effective enrollment is refused (`p5_enrollment_unavailable`) and that a changed root file is still refused.

**Fix 2 — package layout gate**, in `runtime/core/p5Support.mjs:52-61`: in packaged mode the gate accepts bootstrap `tauri` or `engine`. The P6 Engine package has the same layout (`versions/<build>/runtime/runner.mjs` with its payload in `versions/<build>/p5`, so `ENGINE_RELEASE_ROOT`, `ENGINE_ROOT` and `RUNNING_ENGINE_FILE` in `engineRoot.mjs` resolve identically), and every later check is unchanged: the manifest must name the Host-attested build, commit, source and inputs digests; the running bundle must be the reproducible bundle the payload names; the payload files must equal the manifest byte for byte; the trusted verifier must be listed. The returned layout identity is the same, so the Gate's `packageLayoutDigest` binding is unaffected. Unit coverage in `runtime/tests/p5-desktop-layout.test.mjs` (the real bundled gate): `engine` returns the identical layout, `engine` with another source commit still refuses `p5_support_payload_mismatch`, and an unknown bootstrap still refuses. The packaged test now asserts that Engine A's and Engine B's admission decisions list only `causal_verification` — this fixture policy has no causal reproduction — so the layout and `workspace_slot` checks pass in a real P6 installation.

**Fix 3 — Gate dependency-closure contract** (reviewer finding H1b, same root cause), in `docs/schemas/protected-self-repair.schema.json:987`: the `dependencyClosure.installedRelease.bootstrap` enum now admits `engine`, as the running-release contract at line 556 already did. The trusted Gate copies the Host-attested bootstrap into that record and validates it (`p5Gate.mjs:443-447`), so without this a genuine Gate whose checks import any installed dependency would have failed its contract in every P6 Engine package. Unit coverage: `P6-BUILD Contract: a Gate dependency-closure record admits the P6 Engine bootstrap` (`runtime/tests/p6-build-unit.test.mjs:450-459`) accepts an `engine` record and refuses an unknown bootstrap. `npm run docs:check` reports no errors.

Test-only changes:

- `runtime/tests/p6-build-e2e.test.mjs`: `awaitSwitchVerified` (lines 38-53) waits up to 600 s for the Host's own `engine_switch_verified`. It fails immediately if the durable phase becomes `held` or `rolled_back`, or if a failure is recorded beside phase `committed` (the Host's readiness wait already ended). `stopHostRecorded` logs when teardown stops a Host mid-switch. Both switch waits use it.
- `runtime/core/testEngineProbe.mjs:61-65`: one test-only probe action, `p5_materialize_preparation`, which calls the Engine's own production `materializeProtectedSelfRepairPreparation` and also returns the Engine's loaded enrollment reference. The probe starts only in a package carrying the test fault marker and only when the Host-launched process has `DESZO_TEST_ENGINE_PROBE` (`testEngineProbe.mjs:10, 36`).
- Fixture corrections in `p6-build-e2e.test.mjs`, each needed for P5 preparation to be possible at all and none weakening a production check: a real, empty, test-owned slot whose native identity is read by a separate test custody Host before any Engine has the enrollment (lines 260-272), registered as the enrolled workspace (line 762); a whole-tree path policy matching the whole-tree manifests (lines 170-172); an incident category the production P3 classifier can emit (lines 289-290); and C's candidate using the enrolled workspace, as production `verifyP5Receipt` lineage requires (`protectedSelfRepair.mjs:1445-1456`). The slot is emptied (identity kept) after the fresh-clone section. The C trigger no longer names a target build, so C receives the consumer's content-derived build ID (`p6Consumer.mjs:377`) exactly as B did: A→B was started by Engine A's own startup projection reconciliation (`engine.mjs:1411-1412`), which names no target, so the route's later request for `engine-b` was moot (`engine.mjs:1419`). The test header now says so, and the test asserts B's build ID is `engine-<candidateId[0:12]>` and not the route's `engine-b`. The fixture handoff itself remains fixture-authored.

## 9. Why no Host redesign was needed

The Host did what G0 specifies. It kept one managed Engine record, ended it only on an owner stop, never reported a dead candidate ready (`accept_ready` refuses without a live record, and readiness needs the exact application/Engine PIDs, installation, profile, Shell, build and generation, `lib.rs:2140-2183`), kept the committed selector authoritative and did not roll back after the commit. With the harness wait corrected and no Host change, the same Host binary (`5780e254…`) reached `verified` in every run.

One Host observation is recorded for review, not changed: the switch worker checks candidate liveness (`engine_switch.rs:738-746`) before a 15–19 s package re-verification and checks neither liveness nor a pending Host stop again before the commit write (`engine_switch.rs:759`). A stop or candidate exit inside that window produces a committed selection whose readiness cannot complete in that Host lifetime. The production Store stays guarded until the commit, the candidate never opened it, the durable phase is `committed` and a restart starts the committed Engine (`engine_switch.rs:1028-1041`), so no G0 safety invariant is broken. See §23.

## 10. B maintenance-to-normal transition (packaged run 3)

Root `.deszo/tests/p6-build-e2e-6shy3d`, Host PID 13068. Times are seconds after the trigger.

| Event | s | Facts |
| --- | --- | --- |
| `engine_staged` | 74.7 | B `engine-fdfb86e0cbb9`, package `72c6b1cd91d2bc8a97c168c2a12229c5707c798a1cc7e6c6e5e21c7eb7b1cad5` |
| `engine_switch_accepted` | 88.0 | from `engine-a` generation `eab43d19-…` |
| `managed_process_tree_stopped` (A) | 91.0 | Shell 21584, Engine 16964 |
| `application_spawned` (B) | 98.1 | Shell 25584, candidate generation `09c07b75-0f7f-4f0a-a8f0-c3f4783f7a39` |
| `engine_preflight_passed` | 100.5 | Engine 19900; schema 22, 22 migrations, `quick_check` ok, copy `08795f69…` |
| `engine_store_boundary_verified` | 101.0 | |
| `engine_switch_committed` | 115.8 | |
| `engine_switch_verified` / `engine_ready` | 127.6 | same Engine 19900 under Shell 25584 |

The same B process (19900) ran the preflight, received the commit, continued into ordinary startup, resolved its continuation and sent readiness. Runs 1 and 2 show the same sequence (verified at 172.4 s and 146.2 s).

## 11. Host selector and operation identity

After run 3's commit and readiness: `active.json` = `{ buildId: engine-fdfb86e0cbb9, digest: 72c6b1cd…, generation: 09c07b75-…, committedOperationId: 537a470e-4c9a-462f-9bee-5a1b20279ad0 }`. The durable operation: phase `verified`, `fallbackAttempted: false`, from `engine-a` to `engine-fdfb86e0cbb9`, Shell `shell-g0`, receipt `{ enginePid 19900, applicationPid 25584, storeId 6b543951-… }`.

## 12. B readiness and runtime API

Assertions that passed in runs 1, 2 and 3: Engine B's descriptor carries the `engine-b` marker; the journal order is `engine_staged` → `engine_switch_accepted` → `engine_preflight_passed` → `engine_store_boundary_verified` → `engine_switch_committed` → `engine_switch_verified`; the selector names B; phase `verified`, no fallback; Engine A's process is gone and Engine B's is running; Shell and Host executable bytes are unchanged; the `p6.build` receipt names Engine A's exact installed esbuild; `GET /api/v2/settings` on B returns 200.

## 13. B P5 continuation

B's `GET /api/v2/installation/source-release` reports `enrollmentLoaded: true` and the Host release `{ bootstrap: engine, buildId: engine-fdfb86e0cbb9, committedOperationId: 537a470e-…, packageSha256: 72c6b1cd…, sourceCommit: 1c7f9d46d9e124d7baf5e4b847c36331e14b06ce, sourceDigest: 1890921d…, inputsDigest: a8f0ade3… }`. B wrote one durable `p6.continuation` receipt (artifact `2639c2e3-76ac-4cdc-9719-61bce24c0d9b`); the test re-resolved the same effective enrollment from B's Store with the Host switch status.

P5 **admission** in run 3 (before Fix 2) stayed closed in B for `runtime_package_layout(p5_package_layout_unsupported)` and `causal_verification`; with the real slot, `workspace_slot` already passed. With Fix 2 the only remaining reason in A and B is `causal_verification`, a limitation of this synthetic fixture's verification policy (no `causalReproduction`), not of the product (§12, §24).

## 14. F-15 negative baseline

Two independent reproductions on the current tree:

- `runtime/tests/p5-managed-clone.test.mjs` (1/1 pass, 214 s): commit B exists on a test-owned bare server but is not advertised; the pinned protocol-v0 client's `git fetch <origin> <B>` is refused by the real server ("Server does not allow request for unadvertised object 0808df5f…"), and actual `prepareP5WorkspaceFromIntent` falls back to the enrolled `refs/heads/main` and fails closed with `p5_git_source_commit_unavailable`.
- Packaged run 3, on the real Engine B: the enrolled origin (`file:///…/p6-build-e2e-6shy3d/sources/source-a`, refs `refs/heads/main` = A `eb29501214e33253b6d188e1f0c645d2d12f214f`) does not contain B at all. `git fetch <origin> 1c7f9d46…` exits 128 with "upload-pack: not our ref 1c7f9d46…". B's own preparation of the same effective enrollment **without** its `verifiedLocalSource` fails closed with `p5_git_source_commit_unavailable`.

No network error was fabricated in either case.

## 15. Store-backed source positive integration

In packaged run 3 the test journaled a fresh queued Repair against B's exact effective enrollment, and Engine B — the Host-selected process (pid 19900, build `engine-fdfb86e0cbb9`) — ran its production `materializeProtectedSelfRepairPreparation`. That path re-verified the installed enrollment (with the §8 fix), re-checked the baseline against the Host's current release, and called `prepareP5WorkspaceFromIntent` with `prepareP5GitRepositoryFromIntent`. Inside it, `fetchInstalledCommit` called `verifyP6GitObjectSource`, which re-verified the enrolled repository identity, the Host-selected release, the P6 build receipt, the continuation receipt, the accepted handoff and its Git provenance, then materialized the exact blobs, tree and commit from immutable Store artifacts, fetched only `refs/heads/main`, verified complete ancestry, created the repair branch at B, and populated and inventoried the working tree.

| Result | Value |
| --- | --- |
| Preparation | success; journaled `self_repair.workspace_prepared`, artifact `cba85f4b-d511-43da-8f25-dabeda2109f3` |
| Fetch provenance | strategy `store-objects+enrolled-refs`, refspecs `["refs/heads/main"]`, `localObjectSource` = B's exact descriptor (digest `f7a258c0…`) |
| Checked-out HEAD | `1c7f9d46d9e124d7baf5e4b847c36331e14b06ce` = installed B commit |
| Checked-out tree | `a4f48aa5c33b3b982a81d4b66f9734a0156d0795` = verified B tree |
| Parent | `eb29501214e33253b6d188e1f0c645d2d12f214f` = enrolled A; history length 3 |
| Working tree | 185 files, clean; no remote configured; only ref `refs/heads/self-repair/02af3270eb02` |

The test drives this through the test-only probe because the fixture's P5 admission is closed (§13, §24); the probe calls the same Engine method a Repair would, and none of its checks is skipped. From run 5 on, the test also asserts that the intent names exactly the enrollment B loaded at startup. Runs 4, 5 and 6 reproduce the same result with their own identities (§22).

**Store-backed B source in B's own P6 build of C.** In runs 4 and 5 Engine B then built and activated the synthetic C. B's pre-switch source-continuity check reconstructs C's Git objects with B's commit as parent: B's own accepted commit is not on the enrolled origin either, so it comes from B's verified Store-backed source chain: C's handoff names B's effective enrollment, `verifyP6GitObjectSource` returns B's chain, and the consumer materializes it before C's objects, fetches only the enrolled ref and requires complete history (`p6Consumer.mjs:502-522`). The Host committed and verified C (run 5: `engine-fc544da58640`, 121.9 s after the trigger). C's handoff is fixture-authored, so this is not the genuine second acceptance.

## 16. Git identities

| Item | Value |
| --- | --- |
| Object format | `sha1` |
| A commit (enrolled baseline) | `eb29501214e33253b6d188e1f0c645d2d12f214f` |
| B commit / tree | `1c7f9d46d9e124d7baf5e4b847c36331e14b06ce` / `a4f48aa5c33b3b982a81d4b66f9734a0156d0795` |
| Host operation | `537a470e-4c9a-462f-9bee-5a1b20279ad0` |
| B package digest | `72c6b1cd91d2bc8a97c168c2a12229c5707c798a1cc7e6c6e5e21c7eb7b1cad5` |
| B installed source digest / inputs digest | `1890921d922ddec9857f2691fcf0dbd68be4b2a04716b5db7aba265e9d64a6a9` / `a8f0ade316399a03650491c9d2b732a672fe753d71d97d7016f40a39c794c06a` |
| P6 build receipt | `a0e4df18-296e-40b6-8940-7c0e2d58ec7f` (`36ad30ff…`) |
| Continuation receipt | `2639c2e3-76ac-4cdc-9719-61bce24c0d9b` (`a6f260fd…`) |
| Store source descriptor digest | `f7a258c01a1581365ccde8c5aacad1ceda346fc6bf0881e575f14152c16adbb5` |

## 17. Enrolled repository and publication policy

Repository `p6-build-e2e`, remote `p6-test-origin` (`file:` protocol, test-owned), `fetchRefs: ["refs/heads/main"]`, publication `{ enabled: false, remoteId: p6-test-origin, refNamespace: refs/heads/self-repair/, requireExpectedRemoteState: true, allowMerge: false }`. The test asserts B's effective `fetchRefs` and publication policy equal the root enrollment's, and that the origin's refs (`refs/heads/main`, `refs/remotes/origin/HEAD`, `refs/remotes/origin/main`, all `eb295012…`) are identical before and after, with B still unadvertised. No push, branch update or new fetch ref occurred. The repository identity in this fixture is synthetic (`nativeDirectoryIdentity {v1, r1}`); managed-clone preparation compares it only for internal consistency, never against the disk.

## 18. Managed-clone checkout result

See §15: HEAD and tree equal B's installed commit and tree; ancestry B → A → root is complete; the working tree matches all 185 manifest entries byte for byte (checked by the Host inventory inside preparation) and `git --no-optional-locks status` is empty.

## 19. Negative source tests

Through B's actual preparation path (packaged run 3):

| Case | Result |
| --- | --- |
| B enrollment without its local source (remote only) | `p5_git_source_commit_unavailable` |
| Local source naming commit A instead of B | `p5_git_local_source_invalid` |
| Second fresh preparation of the prepared slot | `p5_workspace_conflict`; still one `workspace_prepared` record, HEAD unchanged |

On B's real Store evidence through `verifyP6GitObjectSource` (called first by both the fresh and the recovery preparation paths), each refused with `p5_git_local_source_invalid`: different commit; different tree; different repository; different repository identity; a different Host release (A's); another installed Engine; another Host operation; a missing Store artifact; a changed Store artifact reference; a wrong predecessor enrollment and parent; an invalid continuation receipt; an invalid build receipt.

Object-level, from B's exact Store evidence into an empty repository: a partial object set is refused; the full chain rebuilds B's commit and tree from Store evidence alone; B without its parents fails `p5_git_source_ancestry_incomplete`; after fetching only the enrolled ref the history is complete (length 3) and no ref is written.

## 20. Restart and duplicate behaviour

- **Preparation recovery:** a recovery call on the prepared intent rematerialized the Store chain against the current continuation evidence and returned the same journaled preparation artifact; a non-recovery repeat was refused (§19).
- **Host restart with B committed (run 4, root `p6-build-e2e-Yfv5IV`, B `engine-fbda9ac98067`, operation `d808c53d-9ef7-41e8-8599-225600ad6638`):** the test stops the Host gracefully and starts it again with the same configuration (initial build A). The new Host reconciled the verified operation, launched exactly one Engine — B — and B became ready. No second `engine_switch_verified` was recorded, the operation identity, phase `verified`, package and `fallbackAttempted: false` are unchanged, the selection (build, digest, operation) is unchanged under a fresh lifecycle generation (the Host rotates it on every start, `lib.rs:1036-1038`), B reloaded its enrollment (`enrollmentLoaded: true`, same release) and there is still exactly one `p6.continuation` receipt (committed→verified replay).
- **Crash after commit:** not re-run; covered by the existing G0-C12/C13/C18 native test (`p6-g0-recovery.test.mjs:123`), which crashes the real Host after the selector commit and proves the committed B starts and is never replaced. This stage changed no Host, Shell or G0 code.
- **Held state:** the diagnosed runs show a post-commit hold is recorded beside phase `committed` and the selector stays B (§5), as G0 specifies.

## 21. Host, Shell and package digests

| Artifact | SHA-256 |
| --- | --- |
| Rust Lifecycle Host `lifecycle-host/target/debug/deszo-lifecycle-host.exe` | `5780e2542f5794b318ab62c0d2cfefeddde26138f1052ff6f926b692c5288a50` (unchanged; same binary as the continuity runs) |
| Tauri Shell `shell-g0` | `60cd2526f37c649d444aeeee74f150a62b32fe53d649cac8e2607f1ddbd72dbe` (unchanged) |
| Engine B package, run 3 | `72c6b1cd91d2bc8a97c168c2a12229c5707c798a1cc7e6c6e5e21c7eb7b1cad5` |
| Engine B package, run 4 | `50c643ea456c37eadfd3943b9702ccb9831c1469697cd36e26c67f9caad089a6` |
| Engine C package, run 4 (synthetic B→C) | `dbbf9023efde3ee6750334adb39601d9a58a62214843d46479ceb3effc4b6b6a` |

Each packaged run builds new test-owned Engine packages from the current source, so package digests differ per run. The test asserts Host and Shell bytes are unchanged across each run.

## 22. Focused test results

Only exact test files were run; the full `npm test` regression was not run (§25). All Node runs used the PowerShell/`cmd` environment of §2.

| Command | Result |
| --- | --- |
| `node --test runtime/tests/p6-build-e2e.test.mjs` run 1 (harness wait only) | A→B verified at 172.4 s; every A→B assertion passed; then failed in the synthetic C fixture (`p5_receipt_lineage_mismatch`, C workspace ≠ enrolled workspace) |
| run 2 (+ slot/policy/probe/C workspace) | A→B verified at 146.2 s; fresh-clone step refused inside B with `p5_enrollment_changed` → root cause 2 |
| run 3 (+ Fix 1) | A→B verified at 127.6 s; fresh B managed clone and all negatives passed (§15, §19); the new restart section failed on a test assertion that expected an unchanged lifecycle generation |
| run 4 (+ generation assertion) | A→B verified at 124.1 s; fresh clone, negatives and Host restart passed; synthetic B→C reached `engine_switch_verified` 142.2 s after its trigger; then failed on the test's C build-ID expectation (route asked for `engine-c`) |
| run 5 (+ Fix 2, reviewer follow-ups, C trigger; packages built before Fix 3) | **pass, 1/1 (523.6 s).** A→B verified at 76.6 s (A's startup trigger had already begun the build); A and B admission reasons `['causal_verification']`; fresh clone in B (operation `7e63986e-b846-485c-af62-aabda9520909`, B `engine-ffb6aa057f28`, package `006b9563…`): HEAD `04c768c3c1085becf498e80cc599521381ecd821` = B, tree `14fbbb18b33c46ef4886751f8d05ed4fd02b0d34`, parent A `49cb9dd3…`; remote-only `p5_git_source_commit_unavailable`, substitution `p5_git_local_source_invalid`, duplicate `p5_workspace_conflict`; restart passed with one continuation receipt; synthetic B→C staged C `engine-fc544da58640` (content-derived) and verified it 121.9 s after its trigger; every C assertion passed |
| run 6 (exact final tree, §26) | **pass, 1/1 (568.5 s).** A→B: staged 52.5 s, committed 81.1 s, verified 90.3 s after the trigger (operation `cb131130-9301-4699-b64d-3f94c675c606`, B `engine-d6fc234e13e8`, package `425222dd82eda3ce80074f5f9e484063ed8621b1e788daf48a7688a2162e6a17`); A and B admission reasons `['causal_verification']`; fresh clone in B: HEAD `18eb4b0901498c1204036342a196f409f08c8cc4` = B, tree `b61843bcf748d413231742f4499a7483b4a01328`, parent A `ac3434a0…`, intent bound to B's loaded enrollment; remote-only `p5_git_source_commit_unavailable`, substitution `p5_git_local_source_invalid`, duplicate `p5_workspace_conflict`; restart passed with one continuation receipt; synthetic B→C staged at 92.1 s, committed at 120.2 s, verified at 129.6 s after its trigger with a content-derived C build ID; every C assertion passed |
| `node --test runtime/tests/protected-self-repair.test.mjs runtime/tests/p5-native-source-identity.test.mjs runtime/tests/p5-desktop-layout.test.mjs runtime/tests/p6-build-unit.test.mjs runtime/tests/p6-build-integration.test.mjs` on the final source | **38/38 pass** (includes the Fix 1, Fix 2 and Fix 3 cases) |
| `node --test runtime/tests/p5-managed-clone.test.mjs` (before Fix 2/3; neither touches its path beyond widening two enums) | 1/1 pass (214 s; F-15 protocol-v0 refusal reproduced) |
| `npm run docs:check` (after Fix 3) | no errors |
| `node scripts/run-tests.mjs check` | pass, no tier problems |
| `node --check` on every changed JavaScript file; trailing-whitespace check on changed files | pass |

No Rust, Shell or G0 test was re-run: this stage changed no Host, Shell or G0 code, and the Host/Shell binaries used are byte-identical to those of the continuity runs.

## 23. Independent review

A fresh-context, read-only reviewer inspected the retained roots, the Host journals and the source (it ran no tests).

It confirmed: `state.managed` was removed by the test-initiated Host stop while B was alive (`lib.rs:766-767, 2581-2583`; B readiness at 340.307 refused at `lib.rs:2142-2152`); the harness change addresses the first cause and the 600 s bound with fail-fast is legitimate; a dead candidate cannot be reported ready (`lib.rs:2140-2186`); the committed selector stays authoritative (`engine_switch.rs:576-589`, and the run-3 restart reconciled `verified` and spawned only B); continuation stays Host-operation-bound (`p6Continuation.mjs:87-105, 205-214`); the local Git source cannot impersonate another repository or substitute a commit (`p6GitObjectSource.mjs:37-109, 157-166`; `p5GitCandidate.mjs:660-671`); publication permissions are unchanged (`p6Continuation.mjs:340-346`, `p5GitCandidate.mjs:625-628, 1367-1382`); the real managed-clone API is exercised inside B; synthetic inputs are clearly labelled; no G0 invariant was weakened; the probe is gated; Fix 1 is correct and widens no authority.

Findings and disposition:

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| H1 | High | `verifyP5PackageLayout` refused every P6 `engine` package, so P5 admission and the Gate were closed in every P6 Engine | **Fixed** (Fix 2, §8); proven in packaged runs (A and B admission reasons = `causal_verification` only) |
| H1b | High (fail-closed, contract-breaking) | Raised in re-review: the Gate's `dependencyClosure` contract still allowed only `runtime`/`tauri`, so a genuine Gate using any installed dependency would fail in every P6 Engine | **Fixed** (Fix 3, §8), with a contract unit case |
| — | Low | Evidence classification: A→B is started by Engine A's startup projection reconciliation, not by the test-only route | **Fixed**: test header, assertion on B's content-derived build ID, and this report (§8) |
| M1 | Medium | `engine_switch.rs:738-759`: candidate liveness is checked before a 15–19 s package re-verification; neither liveness nor a pending Host stop is re-checked before the commit, and stdin shutdown does not coordinate with the switch worker. A candidate exit or Host stop inside the window commits B without the pre-commit fallback | **Open, non-blocking** (Store safety preserved; restart starts the committed B). Recommended fix: re-check `managed` liveness and a stop flag under the state lock immediately before `set_phase(COMMITTING)` and fall back on either; have stdin shutdown set `stop_requested`. A Host change needs its own native failing test and review (stage rules), so it is left for a follow-up |
| L1 | Low | `materializeProtectedSelfRepairPreparation` does not compare the intent's enrollment with the Engine's loaded enrollment | Production unchanged (production callers bind it, `engine.mjs:1072-1075`, `linkedRepair.mjs:990`); the test now asserts the positive intent names B's exact loaded enrollment; negatives 1–2 intentionally use other intent enrollments |
| L2 | Low | For a successor, the currency check returns the loaded enrollment, so callers' equality checks reduce to "root file unchanged" | Accepted; every caller re-checks the release against the live Host |
| L3 | Low | Post-commit hold with a dead candidate waited the full 600 s | Fixed in the test (fail fast on a failure recorded beside `committed`) |
| L4 | Low | C fixture reused the slot still holding B's clone | Fixed (slot emptied after the fresh-clone section) |

The same reviewer re-reviewed Fix 2 and the follow-ups. It confirmed Fix 2 is narrow and correct: the `engineRoot.mjs` paths hold for the `engine` layout, all later bindings are unchanged, and the bootstrap value is the Host-attested `build.json` field. It checked the retained run-3 B package itself: payload manifest = release, bundle SHA `265ea94e…` = `runtimeBundle.sha256`, 698 files, verifier listed. It found nothing else in `p5Gate.mjs` assuming a desktop layout and raised H1b. A final check confirmed H1b, the L3 comment and the trigger classification resolved, with **no remaining Critical, High or contract-breaking Medium finding**. M1 stays an open, non-blocking Medium. Its one remaining condition was that the packaged test pass end to end on the exact final tree (§22, run 6).

## 24. Remaining limitations

- **Synthetic P5 inputs.** The packaged test remains *Packaged P6/G0 integration — synthetic accepted P5 input*: A's handoff and C's handoff are fixture-authored, and the fresh Repair's Parent, Repair, P2 authorization and preparation-intent rows are fixture-authored. It does not prove genuine Developer/Gate/Judge acceptance, and A→B→C here is not the genuine two-update acceptance chain.
- **Fresh clone trigger.** The fresh managed clone was driven through the test-only probe calling B's production preparation method, because the fixture's admission stays closed (`causal_verification`). A genuine Repair in the next stage reaches the same method through admission.
- **Fixture identity.** The fixture's repository identity (`canonicalCommonDirectory` = test clone, native identity `{v1, r1}`) is synthetic; managed-clone preparation checks it only for internal consistency. The slot identity is real.
- **M1** (§23) is open.
- **Single-use slot across releases.** After a genuine Repair in A, B's next Repair needs the enrolled single-use slot empty again; P5's retention/cleanup must release it. Not exercised here (the test empties the slot itself).
- **Concurrency artefact.** While the test process wrote fixture rows into B's live Store, one Shell UI poll in B logged `database is locked` (`listRunRequests`); it did not affect the switch or the assertions.
- **Restart coverage.** The P6-specific graceful Host restart is covered; a native crash after the commit is covered only by the existing G0-C12/C13/C18 test with G0 packages, which was not re-run.

## 25. Full regression status

**Not run.** The multi-hour `npm test` belongs after the genuine P5 acceptance → P6 → C stage. Focused tests are listed in §22 and are not a full regression.

## 26. Final source snapshot

Final branch `codex/adr-0003-0005-completion`, HEAD `1f54c47fe265c6b47bf36695be56214056fc3af1` (unchanged), nothing committed or pushed. Source snapshot by the §3 method, excluding this report: **831 paths, `b8faaef2ba7096d8e0cd0466e8127887a0b6c3e8e52d5a566d09b0b5662448e7`**. The snapshot was taken before run 6 and recomputed after it with the same result, so run 6 exercised exactly this tree. The 831 paths are the 829 baseline paths plus the continuity report and the new diagnosis evidence file.

## 27. Readiness for genuine P5 E2E

The genuine autonomous E2E can now start from this tree. Its chain is: genuine P5 Developer/Gate/Judge acceptance in A → automatic P6 → B → genuine P5 acceptance in B → C. The integration boundaries that blocked it are proven:

- B becomes ready after the Host commit.
- B's continuation is Host-bound.
- In a P6 Engine, P5 can re-check its enrollment (Fix 1).
- P5 admission and the Gate accept a P6 Engine package (Fixes 2 and 3).
- A fresh B managed clone checks out B's exact commit from Store evidence, with no publication.
- B's own P6 build of a successor uses that same Store-backed source.

What the next stage still has to supply or prove:

1. **A genuine fixture.** The enrollment's verification policy must have a causal reproduction (P5-CLOSURE §6), so that admission opens. With it, admission's only remaining reason (`causal_verification`) disappears. The enrollment also needs a real repository identity, and a real incident in a Parent Run whose genuine Developer/Gate/Judge path produces A's handoff.
2. **A genuine P5 Gate run inside a P6 Engine package.** This stage proves that the layout gate and the dependency-closure contract accept a P6 Engine package, but no Gate executed in one.
3. **The enrolled single-use slot after A's Repair.** It must be released by P5 retention/cleanup before B's Repair. This stage's test empties the slot itself.
4. **The full Node regression** (about three hours), on the frozen snapshot after the genuine E2E passes.
5. **Tracking M1** — the Host commit-window race — with its own native failing test and review.
