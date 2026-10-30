# P5-CLOSURE — Desktop Packaging, Production Causality & Final Verification

Date: 2026-10-30. Branch `codex/adr-0003-0005-completion`, HEAD `e34995a2095d3683c225d1435136bf8fb516f0e9` (unchanged; all
P5 work is uncommitted in the working tree). Predecessor: `2026-10-29-p5-final-acceptance.md` (verdict `P5 VERIFIED WITH
LIMITATIONS — NOT READY FOR P6`). Architecture amendment: `2026-10-30-p5-closure-architecture-amendment.md` (A1–A7).

## 1. Final verdict

**`P5 VERIFIED — READY FOR P6`**

Every required item of this stage (D1, F3, F2, F5, F14, F12, F9, F10, H1, H2, H3, F17–F19, the taskkill test) is implemented
and proven. The final full regression ran on one frozen snapshot (snapshot 3, 47 working-tree files hashed before and
re-verified byte-identical after the run): **963 tests, 963 pass, 0 fail, 0 cancelled, 0 skipped** (§21). Rust 27/27,
docs check, build and `git diff --check` pass on the same snapshot. Three independent reviews leave no open Critical, High
or contract-breaking Medium finding (§24). The accepted residuals (§25) are inside the cooperative same-user boundary
(A7) or are carried as explicit P6 requirements (§26). None of them blocks P6.

## 2. Starting branch, HEAD and index

| Item | Value |
|---|---|
| Branch | `codex/adr-0003-0005-completion` |
| HEAD at start and at end | `e34995a2095d3683c225d1435136bf8fb516f0e9` (`p5`) |
| Index at start and at end | empty (`git diff --cached --name-only` → 0 entries) |
| Working tree at end | 24 modified tracked files, 23 untracked files (47 paths, §27) |
| Toolchain | Node v22.20.0, Git for Windows 2.39.2.windows.1, `core.autocrlf=true` in the development checkout |
| Test environment | `NoDefaultCurrentDirectoryInExePath=1` (inherited from the user environment; see §21) |

No commit, reset, clean, rebase, stash, checkout or ref update was run in the development checkout. Every repository,
remote, profile, installation root and WebView2 data folder used by tests is test-owned, under `.deszo/tests/` or the OS
temp directory. Nothing was pushed to a production remote, and no installed production release or user profile was touched.

## 3. Production changes

New production modules:

| File | Purpose |
|---|---|
| `runtime/core/engineRoot.mjs` | `ENGINE_PACKAGED`, `ENGINE_RELEASE_ROOT`, `ENGINE_ROOT` (release root, or `<release>/p5` for a bundled release) |
| `runtime/core/p5Support.mjs` | `readInstalledSourceInventory`, `verifyP5PackageLayout` (desktop payload admission check) |
| `runtime/core/p5GitCandidate.mjs` | managed-clone Git candidate, request/execute/status publication split (F9) |
| `runtime/core/p5HostBoundary.mjs` | `P5_TRUSTED_CONTROL_PATHS`, mutation tiers, Host-protected prefixes (F5) |
| `runtime/core/p5Provisioning.mjs` | enrolled slot provisioning |
| `runtime/host/runtimeRelease.mjs` | shared release capture: clean source, committed-blob byte identity (F12), source layout copy, inventory |
| `runtime/host/hostError.mjs` | Host error mapping |
| `scripts/runtime-bundle.mjs` | `bundleRunner` (shared by `bundle-runtime.mjs` and the desktop packager); packaged TypeScript plugin |
| `scripts/desktop-release.mjs` | `packageDesktopRelease` + CLI (`npm run desktop:release -- --source --out --build-id [--git --exe --resources]`) |

Changed production modules: `engine.mjs` (admission checks `runtime_package_layout` and `causal_verification`,
asynchronous publication executor and recovery, bounded capture hold, publication status projection), `p5Gate.mjs` (AST
import scanner, baseline tree + causal plan, dependency-closure manifest, package-layout checks, causal record in settle),
`protectedSelfRepair.mjs` (causal/dependency/capture-hold contracts, receipt verification, tier rules, asynchronous Git),
`p5Verifier.mjs` (R(B) before R(C), dependency re-verification around every check, cause-anchored JUnit classification),
`custody.mjs` (test-only fault hooks, inert in packaged builds), `supervision.mjs` (process listing reports the Attempt id),
`runner.mjs` (`POST …/self-repair/publication` → 202, new `GET …/self-repair/publication`), `linkedRepair.mjs`,
`authority.mjs`, `installedBuilds.mjs`, `sourceProvenance.mjs`, `scripts/bundle-runtime.mjs`, `package.json`
(`desktop:release`), `lifecycle-host/src/lib.rs` (relaunch policy from the predecessor stage; no Host change in this stage).
Schemas: `protected-self-repair.schema.json` (`causalReproduction`, `dependencyClosure`, `captureHold`, receipt/outcome
references, `gitPublicationResult.reason`), `journal-event-v2.schema.json` (`self_repair.capture_held`).

No Host Custody or authorization semantics were weakened; `runtime_package_layout` was kept and extended; no provenance
value is written by hand; no test-mode bypass exists in production code.

## 4. Packaging decision

Decision: **the desktop (Tauri) product is P5-capable through an attested P5 support payload** shipped inside the desktop
release (amendment A1), not by turning the bundle into a source layout and not by trusting the bundle.

- `npm run desktop:build` alone still yields a shell without a payload. It runs normally, with P5 admission refused
  (`runtime_package_layout`).
- `npm run desktop:release -- --source <clean checkout> --out <dir> --build-id <id>` produces the P5-capable release from
  one clean committed checkout.
- The Engine bundle is built from the copied payload sources and rebuilt a second time; both builds must be byte-identical.
  In this stage the payload-built bundle was also byte-identical to the development-checkout `dist-runtime` bundle.
- The bundle no longer inlines TypeScript; it loads it lazily from `p5/node_modules/typescript`. `runner.mjs` shrank from
  12,471,898 to about 2.59 MB (2,586,452 bytes in the desktop release of §19).

## 5. Desktop artifact layout

```
versions/<buildId>/
  deszo.exe                        desktop shell (Host side, digest recorded, never repairable)
  runtime/                         desktop runtime resources; runtime/runner.mjs is built from p5/
  p5/                              attested runtime source layout + shipped node_modules closure + p5-support.json
  .deszo-source-inventory.json     committed source inventory served by the Host for source attestation
  build.json                       bootstrap "tauri", sourceCommit, sourceDigest, inputsDigest, artifacts, p5Support
```

`p5-support.json` records the builder (`node`, `esbuild`), the reproduced bundle digest, the payload file list with
digests, the `deszo.exe` digest and the digests of every copied desktop resource (`bridge.mjs`, Host-side bundles, SQL).
Unit proof: `P5-CLOSURE desktop layout: the bundled Engine admits only its exact attested P5 support payload`
(`runtime/tests/p5-desktop-layout.test.mjs`): a missing payload, an extra file, a changed byte, a changed bundle and a
mismatched release are each refused with their own code (`p5_package_layout_unsupported`, `p5_support_payload_missing`,
`p5_support_payload_mismatch`, `p5_support_bundle_mismatch`).

## 6. Host attestation

No Rust Host change was required. The Host's existing `verify_build`/source-release mechanism attests the whole desktop
release (package digest, source inventory, runner/bridge/shim digests) exactly as for runtime-bootstrap releases. The
Host rebuilds nothing, so `sourceCommit` and `inputsDigest` are the packager's measured claims: the packager is part of the
trusted build base (A1.3), and `p5-support.json` carries the toolchain and copied-resource digests so P6 can re-derive or
compare them. The Engine verifies the Host-attested source inventory locally against the attested `sourceDigest` with one
Host call; per-batch Host digesting made the desktop Engine miss its readiness timeout and was replaced.

## 7. Enrollment/admission

Admission checks added: `runtime_package_layout` (now: runtime-bootstrap with the verifier present, or a bundled release
whose payload passes `verifyP5PackageLayout`) and `causal_verification` (the enrolled verification policy must declare
`causalReproduction`). The earlier checks (enrollment identity, release identity, Host attestation, Git tool identity,
slot ownership) are unchanged. `verifyP5PackageLayout` runs at admission and again at Gate prepare and settle; the plan
records `packageLayoutDigest`, and settle (including after recovery) recomputes and compares it (review R7).
Negative proof: `P5-E2E1-NEGATIVE E1-N01/N02/N03` (missing, tampered or wrong-release enrollment keeps admission closed),
and the desktop-layout unit test above.

## 8. Production Gate B/C

The trusted Gate materializes `<verify>/execution/.baseline/<checkId>` only from enrolled baseline Store objects, Host-scans
it, and runs R(B) with the same captured command, environment and incident inputs before R(C), in the same Custody-owned
verifier invocation. R(B) counts as `reproduced` only when the JUnit report is complete, every `baselineMustPass`
assertion passed, every `baselineMustFail` assertion failed with a first `cause:` line starting
`AssertionError [ERR_ASSERTION]:`, and the exit code is 1. Load/dependency/runtime errors, timeouts, signals, missing
cases and drift never reproduce. Lists are compared order-independently (R3) and qualified `class::name` assertions match
(R11). A passing receipt requires `reproduced` + R(C) passed + all required checks passed.

Proofs: unit `P5-CLOSURE causal Gate: R(B) must show the defect and R(C) must pass; infrastructure errors never reproduce`
and `P5-CLOSURE review R3/R9/R11`; installed desktop run §19 (`causalBaseline.status = reproduced`, exit 1,
`defectFailed: [incident-repaired]`, candidate exit 0); every installed happy path now runs the causal policy.

## 9. Receipt identity

`ProtectedSelfRepairCausalReproduction` binds baseline commit and digest, candidate id, incident outcome and revision,
command, inputs, the baseline tree capture, both observations and the dependency-closure digest. The receipt and the
verification outcome reference it, and `p5VerificationReceiptId` includes it. `verifyP5Receipt` requires the record exactly
when the policy requires causality and refuses it otherwise; it recomputes the baseline tree inventory digest, checks
`exitCode === 1`, and binds the dependency closure's installed release to the enrolled release (R10). Receipts issued
before this stage keep their identities and never gain causal authority.

## 10. Dependency closure

`ProtectedSelfRepairVerificationDependencyClosure` lists every served dependency file (path, SHA-256, size), the packages,
the installed release (build, package digest, bootstrap) and the release artifact list (`build.json` or
`p5/p5-support.json`) every file was checked against. Optional and peer dependencies are followed when installed (F17).
The record lives in verify scratch (`dependency-closure.json`); the plan carries only its path and digests (the full record
exceeded the 120 KB Custody admission limit). The verifier re-verifies the served files before and after every check,
R(B) included, so no check can change what a later check imports; the receipt binds the record.
Proofs: unit `P5-CLOSURE F2: served dependency bytes are bound before and after every check`; desktop run §19
(214 files, 7 packages, `artifactList: p5-support.json`).

## 11. Mutation tiers and module resolution

One list, `P5_TRUSTED_CONTROL_PATHS`, drives both the Gate's attestation and the `repair-authority` tier (now including
`engine.mjs`, `custody.mjs`, `linkedRepair.mjs`, `workflowJudge.mjs`, `store.mjs`, `p5Support.mjs`, `engineRoot.mjs`,
`p5Provisioning.mjs`, `workspaceIsolation.mjs`). `engine-custody` must include every `repair-authority` check; every other
shipped Engine input (`runtime/`, `shared/`, `mcp/`, `docs/examples/`, `docs/authoring/`) is at least `engine-core`;
`dist-runtime/` and `dist/` are Host-protected. Accepted residual (R6): the trusted list is not import-closed (§25, §26).

The subject import scanner is an AST walk (`ts.createSourceFile`). It refuses loader names (`require`, `createRequire`,
`_load`, `getBuiltinModule`), `process.binding`/`dlopen`, dynamic `import()`, `import.meta.resolve`, computed specifiers,
`vm`/`worker_threads`/`wasi`, `node:module` except `builtinModules`/`isBuiltin` (never re-exported), `eval`, `Function`,
computed members of `process`/`globalThis`/`global`, and literal keys naming those owners or evaluators. Strings and
comments are inert. Indirections (variable aliases, destructuring, parenthesised/comma owners, `Reflect.get`,
`.constructor`) are not followed; that is inside the cooperative boundary (A7).
Proofs: unit `P5-CLOSURE F14: module-loader bypasses are refused in subject closures; inert text and the Engine closure are
not`; tier expectations in `p5-managed-clone`; installed `P5-FINAL-NEG-AUTHORIZATION` (§20).

## 12. CRLF proof

Packaging refuses unless every working-tree file's Git blob SHA-1 equals the committed blob (`ls-tree HEAD`). P5's own Git
always pins `core.autocrlf=false`, `core.eol=lf`, no attributes file, and refuses text/eol/filter attributes.
Proof with real Git for Windows 2.39.2: `P5-CLOSURE F12: release, baseline and candidate bytes are the committed blobs
under every autocrlf setting` (`runtime/tests/p5-crlf-identity.test.mjs`), on test-owned repositories:

- `core.autocrlf=false` and `input` clones package; the release inventory, the installed bytes and the committed blobs are
  byte-identical for every file.
- An `autocrlf=true` clone (which Git reports clean although its working tree is CRLF) is refused ("differ from the
  committed Git blob").
- A `*.mjs text eol=crlf` attribute is refused at packaging and by P5's attribute policy (`verifyP5GitAttributes`).
- P5's pinned Git on the `autocrlf=true` repository reads exact blobs and stages exact sealed bytes (a mixed CRLF/LF
  candidate is stored as its own blob id, no normalization).

Together with the managed-clone and installed tests (same pinned Git for baseline, clone, candidate commit and handoff),
this gives one byte identity across release, baseline, candidate and handoff. A consequence: the
development checkout itself (`core.autocrlf=true`) cannot be packaged, by design; every test packages from a test-owned
clean clone.

F18 (mixed line endings in the working tree) is mitigated, not removed. In the development checkout, files untouched since
checkout are CRLF (`core.autocrlf=true`), while the files changed or added in P5 are LF: 21 of 24 modified and all 24
untracked (`git ls-files --eol`). Git normalizes both to LF on commit. The mix can no longer reach a P5 identity, for two
reasons. Packaging refuses any working tree whose bytes differ from the committed blobs. P5's own Git pins
`core.autocrlf=false`. The development checkout's files were not renormalized in this stage, which would have rewritten
untouched files.

## 13. Publication state machine

`POST /api/v2/runs/{id}/self-repair/publication` journals the create-only intent and returns 202. One executor per Repair
runs it with non-blocking Git: read the remote ref → exact commit present ⇒ `published`; other object ⇒ `conflict` (final
for that remote URL, never overwritten); absent ⇒ re-check eligibility synchronously immediately before the write, push
`--force-with-lease=<ref>:` with the exact `commit:ref`, then settle by reading the ref again. `GET` returns
`not_requested` / `executing` / `held_uncertain` / `published` / `not_published` / `conflict`. Startup recovery reconciles
open intents read-only first and never blindly repeats a push. A recorded success survives a later Stop; a request after
Stop is refused. Proofs (in `P5-GIT-2 managed clone`, `p5-managed-clone.test.mjs`): conflict, Stop before push, open-intent
reuse, interrupted push then reconcile (`publication: refs/heads/self-repair/… -> … (reconciled after an interrupted
push)`), replay; installed desktop publication §19.

## 14. Transient capture

A transient Host or dependency failure during capture writes a `ProtectedSelfRepairCaptureHold` record (schema
`captureHold`) and a `self_repair.capture_held` event (`{record}`), and retries the exact capture (same Attempt, anchor and
Git commit intent) after 10 / 30 / 60 s. The budget is counted from the journal across Engine restarts; when spent, the
Attempt fails closed `p5_capture_unavailable` ("stayed unavailable after 3 bounded retries"). The hold is live work of its
Run: a placeholder in `this.processes` keeps the Run `running` (never parked in an Owner-decision wait) and keeps the
Developer workspace locks until the hold ends. Root or scoped Stop cancels a waiting hold at once; a Stop during an
in-flight retry is recorded on it, and its authority checks fail it closed. An Engine shutdown is never a Stop: it spends no
hold, does not cancel the Attempt, and waits for an in-flight retry before the Store closes; the next Engine continues the
same durable capture through Custody re-delivery.
Proofs (installed, real Host, fault `DESZO_P5_TEST_TRANSIENT_CAPTURE`): `P5-CLOSURE-F10-RECOVER` (ECONNRESET after the
candidate commit, retried, captured exactly once), `P5-CLOSURE-F10-EXHAUST` (3 holds, Attempt failed, no candidate),
`P5-CLOSURE-F10-STOP` (1 hold, Developer `canceled`, nothing captured, verified or accepted).

## 15. Uncertain tree

`P5-CLOSURE-UNCERTAIN-TREE` runs a P5 Developer under the real Host with the Host debug hook
`custody.testUndrainedDrainMs: 300`, which produces a genuine "exited, process tree not proven ended" state. The established
Custody contract applies unchanged: the Attempt is not accepted and the Repair fails closed; the workspace hold stays held
across an Engine replacement (two different Engine PIDs) until the Host proves the end, then is `released`; nothing is
captured, sealed, verified or published. The P5 path does not resume an uncertain Developer, by design (A7).

## 16. Interrupted fetch

The partial-fetch case (H2, E-08) uses the pinned `git-interrupt-client` fixture (`runtime/tests/fixtures/
git-interrupt-client.rs`) in front of real Git for Windows. It interrupts real fetches mid-transfer, leaving a partial
temporary pack (and optionally a stale remote-tracking ref), and fails like a lost connection. Proven in `P5-GIT-2 managed
clone`:

- Both fetch strategies interrupted → preparation fails `p5_git_source_fetch_failed`; no baseline and no fetch result are
  recorded; the installed commit is genuinely absent; the partial pack is left in place (P5 never deletes).
- A non-recovery request on that state is refused (`p5_workspace_conflict`); it never adopts partial state.
- Startup recovery of the same durable intent (`recovery: true`) with the remote reachable refetches and verifies: the
  baseline is the exact installed commit with complete verified history; the unrelated partial pack is still untouched.
- A stale remote-tracking ref left by an interrupted transfer is refused (`p5_git_*`) and retained.
- The original upstream checkout is unchanged by every fallback case.

The eight other E-08 interruption points remain covered in the same test.

## 17. C07/C09

- `P5-CLOSURE-C07` (installed, real Host, crash-once marker `p5_before_gate_receipt`): the Engine exits between verifier
  completion and receipt issue; the replacement Engine issues exactly one receipt for the original Gate Attempt
  (`admittingEpoch 1`).
- `P5-CLOSURE-C09` (installed): a Repair Judge active during Engine replacement is reattached and accepts exactly once
  (2 Judge invocations, one handoff).

Final-run diagnostics (snapshot 3):

- `P5-CLOSURE-C07`: gate c1c3a8f1-efa4-4dca-8893-0b667ada6a7a custody b65c248f-56a0-4658-8e60-9430bb41f5f4 receipt aeaf85b121893914466bf6c647722d9d559f427cc8f61ed59abcfdaacc7daa49 admittingEpoch 1
- `P5-CLOSURE-C09`: judge invocations 2 handoff c4dc69a4d4d6dbd4b96972183c90e46b8e558c2eb65a1a5e52befd3d55b7ff2b

## 18. F1–F19 disposition

The original wording of F1–F19 was recovered verbatim from the P5-FINAL independent review transcript (not reconstructed).

| ID | Original severity | Original finding (short) | Disposition |
|---|---|---|---|
| F1 | High | candidate `node_modules` could shadow installed dependencies | Resolved in P5-FINAL (protected segments, case-folded) |
| F2 | High | materialized dependency bytes not bound into the receipt | **Resolved** (§10) |
| F3 | High | production Gate never runs R(B) | **Resolved** (§8, §9); admission requires it (§7) |
| F4 | High | tiers add no extra verification | Resolved in P5-FINAL (tier check must be a protected-overlay check resolving the path) |
| F5 | Medium | tier paths inconsistent with the trusted closure | **Resolved** (§11); import-closure residual R6 accepted (§25) |
| F6 | Medium | open publication intent unreconcilable once ineligible | Resolved in P5-FINAL; kept in the async design (§13) |
| F7 | Medium | live Git candidate check not mandatory before push | Resolved in P5-FINAL |
| F8 | Medium | eligibility optional; enrollment ref unverified | Resolved in P5-FINAL |
| F9 | Medium | push runs synchronously on the Engine event loop | **Resolved** (§13) |
| F10 | Medium | transient capture hold has no bound or retry | **Resolved** (§14) |
| F11 | Medium | desktop bundle not verifiable | **Resolved**: P5-capable desktop package (§4–§6, §19) |
| F12 | Medium | possible CRLF/autocrlf byte mismatch | **Resolved** with real Git for Windows (§12) |
| F13 | Medium | legacy manifests re-classified | Resolved in P5-FINAL |
| F14 | Low | module-loader bypass of the subject closure | **Resolved** (AST scanner, §11); indirection residual inside A7 |
| F15 | Low | review hunk `contextAfter` unchecked | Resolved in P5-FINAL |
| F16 | Low | publication replay identity | Resolved in P5-FINAL |
| F17 | Low | "The dependency-closure and plain-file walkers are duplicated. `installedDependencyClosure` ignores `optionalDependencies`/`peerDependencies`." | **Partially resolved**: optional and peer dependencies are followed (both walkers). The two walkers (`runtimeRelease.mjs`, `p5Gate.mjs`) remain separate but identical (Low, R13 accepted) |
| F18 | Low | "Line endings are mixed in the working tree. Git normalizes them on commit, but this interacts with F12." | **Mitigated** (§12): the development working tree is still mixed (changed/new files LF, untouched files CRLF), but no P5 identity can be derived from it; packaging requires committed-blob bytes and P5's Git pins `autocrlf=false` |
| F19 | Info (pre-existing design) | "The protected test runs in-process with candidate code. The candidate can monkeypatch `node:assert`'s exported objects or `process.stdout` and the JUnit reporter, so the overlay only protects test files, not test semantics. The Judge is the backstop." | **Accepted boundary** (A7). Narrowed: R(B) runs only installed code, so causality cannot be faked by the candidate; the dependency closure is re-verified between checks. Out-of-process assertions remain a long-term option |

## 19. Desktop installed E2E

`P5-CLOSURE-DESKTOP: the packaged desktop runtime repairs runtime/core/engine.mjs through P3 → P4 → P2 → causal Gate →
Judge → handoff → publication`. A test-owned clean clone is packaged with `packageDesktopRelease` (real `deszo.exe` from
the Tauri build), installed by the real Rust Lifecycle Host as `versions/build-a` (bootstrap `tauri`), and launched with a
per-session WebView2 data folder. Evidence from the final run (snapshot 3, `ok 646`, 204.5 s):

| Item | Value |
|---|---|
| Bootstrap | `tauri` |
| Package digest | `2c3676902c0812a2e0b7dd900c1c673d708d81e41b664c544c19a3a4f1f1aac9` |
| `deszo.exe` digest | `fd646145f84bd938746924a3405b5bcddf89e8e7e49964e0f09ec94aa4cd989a` |
| `runner.mjs` | `dd3cd2ee0e4f7b7f91d185e56e62b99a1304bc42487a9ed36d97321d2da91180`, 2,586,452 bytes |
| `p5-support.json` | `4b723fa5353ea31d4784a9c611091f2930d46c127fcbced47f9a7b57bb2a2762`, 679 payload files |
| Parent Run / Repair Run / link | `cc99d713-b553-451f-9abe-b848237bc519` / `e0e7bf40-ce4e-496e-9b3f-e519324bd064` / `4c6800f2-5568-468d-9dc4-31eb943fa94b` |
| Incident | `runtime/core/engine.mjs` `loopStep`: expected `pause_iteration_limit`, observed `next` |
| Developer Attempt / Custody | `901beef7-b5ee-4472-a7a4-2811f1b2c814` / `3928c21c-91c7-4fad-ab47-4f254fa5ccbf` |
| Gate Attempt / Custody | `d8cc8000-6bd3-4a05-a4fc-98d7ebf4e78f` / `7a1baadf-9bce-40f7-b0ec-7bdfd1b181bf` |
| Mutation tiers | `repair-authority` |
| Installed (baseline) commit | `f7312dc58d1abad0bfa54b55ab9a8d9dd48700e4` |
| Candidate commit / tree | `9cf8f80e014d7b4e751f6efbb2732f7b15d8e730` / `e9d6b6f59eb5441f1149a20659fc0e3d8020a9e3` on `self-repair/4c6800f25568` |
| Candidate id / source digest | `d4b5a7dce8d17a812d70f99c840cdb158c19aab3a95489cc07bdf76d21359fdb` / `1365754b41f4acf2df5e55a80e5846fee01e6dbe9f89b469457e567421cafe68` |
| R(B) | `reproduced`, exit 1, defect failed ['incident-repaired'], baseline `f7312dc58d1abad0bfa54b55ab9a8d9dd48700e4` |
| R(C) | exit 0 |
| Causal record | artifact `83b4965a-9683-4917-bcc5-bbf30778a2de`, sha256 `9d3518a44e54c77ce657f558bd5a3186d6d64cda1f22d5018afc54ab9cd2acb8` |
| Dependency closure | 214 files, 7 packages (ajv, ajv-formats, fast-deep-equal, fast-uri, json-schema-traverse, require-from-string, typescript), artifact list `p5-support.json`, digest `0fe7d4e89ef02de671ea3a8a4e0f0db6128af6c043f66a4215723f2c4f92e19d` |
| Receipt | `069c4e5aa5fdd8f00291813a822b3e3d5a32e8a6557491b54357f50e6e38a2f8` |
| Approval artifact / handoff | `22cc0ab1-80c7-4144-8d11-41681f45dbba` / `5ee88d2fc49fe6af69dd4b87438e6d642a600c59e9d59262ff8581a001e35290` |
| Publication | `refs/heads/self-repair/4c6800f25568` → `9cf8f80e014d7b4e751f6efbb2732f7b15d8e730` (result artifact `238eb2bc-812e-4534-b678-3845203bd484`) |

Journal, Parent: `27:attempt.failure_outcome`, `41:continuation.linked_repair_opened`, `48:continuation.repair_result_accepted`, `49:continuation.parent_resumption_blocked`.
Journal, Repair: `15:self_repair.preparation_intent`, `16:self_repair.workspace_prepared`, `30:self_repair.candidate_capture_started`, `31:self_repair.git_commit_intent`, `34:self_repair.candidate_captured`, `41:self_repair.verification_started`, `51:self_repair.verification_recorded`, `85:repair.approval_recorded`, `89:self_repair.retention_changed`, `90:self_repair.cleanup_deferred`, `91:self_repair.handoff_recorded`.

The Parent ends `continuation.parent_resumption_blocked`: P5 never resumes the Parent on repaired code; activation is P6.

## 20. Engine/P5 regression

All P5 installed and unit cases ran inside the final full regression (§21) on snapshot 3. Results by group:

| Group | Tests (TAP ids) | Result |
|---|---|---|
| P5-CLOSURE unit (F12 CRLF, desktop layout, causal Gate, F2, F14, R3/R9/R11) | 640, 641, 672–675 | 6/6 pass |
| P5 installed happy paths (E2E1-HAPPY, ENGINE-CORE, P5-MODULE, **CLOSURE-DESKTOP**) | 642, 644, 645, 646 | 4/4 pass |
| P5 installed recovery (E2E1 Developer/Gate recovery, UNCERTAIN-TREE, C07, C09) | 643, 647, 648, 649 | 4/4 pass |
| P5 installed transient capture (F10-RECOVER, F10-EXHAUST, F10-STOP) | 650, 651, 652 | 3/3 pass |
| P5 installed negatives (NEG-VERIFIER, NEG-ASSERTIONS, NEG-AUTHORIZATION, JUDGE-QUESTION, E1-N01/02/03, N05–N08, N11, N12, N16) | 653–664 | 12/12 pass |
| P5-GIT-2 managed clone (ancestry, Host boundary, E-08 incl. partial fetch, publication) | 665 | 1/1 pass |
| P5 verifier/source-identity/startup/contract unit tests | 534, 535, 666–671, 743–756 | 22/22 pass |

52 P5-named top-level tests, all `ok`. The installed cases took 40–204 s each (desktop 204.5 s).

The one failure on snapshot 1 (`P5-FINAL-NEG-AUTHORIZATION`) was a stale test expectation, not a product defect: F5 moved
`engine.mjs` to the trusted list, so a candidate touching `engine.mjs` and `workflowJudge.mjs` is classified
`repair-authority` only, while the test still expected `['engine-core', 'repair-authority']`. The test now expects
`['repair-authority']`, consistent with `P5-FINAL-ENGINE-CORE`.

The environment-sensitive taskkill test (`managed-task.test.mjs`) no longer changes the process working directory: it
places its failing `taskkill.exe` fixture through a PATH prefix, so it passes with `NoDefaultCurrentDirectoryInExePath=1`
set (production code still resolves the bare `taskkill`; no protective variable is unset).

## 21. Full Node results

`npm test` (`scripts/run-tests.mjs`, all tiers) on snapshot 3. Started 2026-10-30T15:50:54+03:00, finished
17:24:11+03:00. Log summary:

```
1..932
# tests 963
# suites 0
# pass 963
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5595006.5477
exit 0
```

Snapshot 3 is HEAD `e34995a`, index empty, plus 47 working-tree files whose SHA-256 values were recorded before the run and
re-verified identical after it. Environment: Node v22.20.0, Git 2.39.2.windows.1, `NoDefaultCurrentDirectoryInExePath=1`
set. The runner reported that some test roots could not be removed (`node scripts/test-artifacts.mjs status`). They are
retained test-owned directories of finished owners, not failures.

Earlier snapshots are not combined into this result. Snapshot 1 ran 962/963 (the stale NEG-AUTHORIZATION expectation,
§20). Snapshot 2 was stopped because review fixes changed production source. Only snapshot 3 counts.

## 22. Rust

`cargo test` in `lifecycle-host` on snapshot 3: `27 passed; 0 failed` (plus two empty doc/bin targets). No Rust source
changed in this stage.

## 23. Build/docs/desktop

On snapshot 3: `npm run docs:check` exit 0 (`errors: []`); `npm run build` exit 0 (did not change any tracked file);
`git diff --check` exit 0. The desktop release used by §19 is built by `packageDesktopRelease` from a test-owned clean
clone with the Tauri `deszo.exe` (Proof B build cache). After the regression, the only edit was to documentation: a stale sentence in amendment §A7 that still described the workspace lock as released during a hold, while the code keeps it. This report was also added. `npm run docs:check` and `git diff --check` were rerun afterwards (§27).

## 24. Independent review

Three fresh-context, read-only reviews ran on this stage (no edits, no Git writes):

1. **Closure review** (R1–R16). R1 High (P5 desktop packager reachable only from a test) — fixed with the CLI and npm
   script. R2–R12, R15 — fixed (R2 provenance recorded and documented as trusted build base; R3 order-independent lists;
   R4 scanner hardening; R5 causal admission; R6 documented residual; R7 layout digest persisted; R8 synchronous
   eligibility before push; R9 cause-anchored classification; R10 receipt checks; R11 qualified names; R12 409 mapping;
   R15 capture-hold schema). R13 (duplicate walkers), R14 (env-gated test fault hooks in runtime-bootstrap releases), R16
   (payload re-hash cost) — accepted, Low/Info.
2. **Re-review 1.** R4 bypass via literal keys (`globalThis['eval']`, `globalThis['process']`) — fixed; capture-hold timer
   resuming an Owner-wait Run (Medium) — fixed (hold is live work; Run stays `running`); R6 — documented with its P6
   consequence.
3. **Re-review 2 + focused recheck of the final hold code.** Re-review 2 found a **High**: a held Attempt left non-terminal
   when a Stop was already in flight or the Run drained — fixed. The focused recheck confirmed it resolved and the
   double-settlement Medium resolved, and found a new **Medium-High, contract-breaking** item N1: an Engine shutdown during
   the first capture await cancelled the Attempt instead of handing it to the next Engine (contradicting A7). Fixed: a
   shutdown returns before any hold or cancel. In the same pass: workspace locks now stay held during a hold (was an
   accepted residual); shutdown awaits an in-flight retry; scoped Stop finds the held Attempt; `/processes` reports the
   Attempt id; cancel reasons name the actual cause.

Open after review: no Critical, High or contract-breaking Medium finding. Remaining Low items are listed in §25.

## 25. Remaining risks

Accepted, none contract-breaking for P5:

1. **Cooperative same-user boundary (A7, F19).** Candidate code under verification runs as the same user, in-process with
   the protected check. No OS sandbox exists, and none was requested. A Git working directory does not isolate a hostile
   same-user Developer.
2. **Trusted list not import-closed (R6).** Engine modules imported by trusted files (e.g. `planning`, `streams`,
   `transport`, `mapRuntime`, `taskRuntime`, `shared/effort.mjs`) are `engine-core`. Only the installed v1 copy runs in
   the active Gate, and every loaded installed file is attested, so the current repair is unaffected; the consequence is
   for P6 (§26).
3. **Packager trusted base (R2).** The Host attests what the packager measured; it does not rebuild. esbuild and copied
   desktop resources are recorded by digest, not derived from `sourceCommit`.
4. **Scanner indirections (R4 residual).** Aliases, destructuring, `Reflect.get`, `.constructor` are not followed (inside A7).
5. **Test fault hooks (R14).** The new crash-once and transient-capture hooks are inert in packaged (bundled) builds and
   in runtime-bootstrap releases only react when their test environment variable names an existing marker file. The older
   `custodyFaultPoint` and `crashBeforeIdentityPoint` hooks are gated by environment variable only, in every build. Setting
   them requires control of the Engine's environment, i.e. the same user (A7); they can only end the Engine, never grant
   acceptance.
6. **Retry under Stop (N2, Low).** A Stop during an in-flight capture retry does not short-circuit the retry; the Stop's
   candidate invalidation makes the retry fail closed, and if it lands after the last authority check the Attempt can
   commit `succeeded` whose candidate every later gate refuses. Not exploitable; no acceptance is possible.
7. **Shutdown fix N1 has no dedicated test.** Installed tests replace the Engine by process kill, which never runs the
   graceful `shutdown()` path; N1 is covered by code review and by the unchanged F10 cases only.
8. **Uncertain tree fails closed.** An unproven Developer tree ends the Repair rather than resuming it (established Custody
   contract); the Owner must start a new Repair.
9. **Duplicate dependency walkers (F17/R13)** and per-admission payload re-hashing (R16).
10. **Mixed line endings in the development checkout (F18).** This is cosmetic for P5 (§12). Committing normalizes the
    files to LF; the development checkout itself is never packaged.

## 26. P6 handoff requirements

1. P6 must re-verify every accepted handoff independently; P5's receipt is an input, not activation authority.
2. P6 must verify any accepted change to a module in the trusted closure's import graph at the `repair-authority` level
   (or close `P5_TRUSTED_CONTROL_PATHS` over its imports first), because such a change runs inside the next installed Gate.
3. P6 must re-derive or compare the packager's claims (`build.json` artifacts, `p5-support.json` builder and resource
   digests) when it builds a release from a handoff.
4. P6 builds and activates outside P5. The Lifecycle Host stays outside all mutation and activation authority; Self-Repair
   never modifies the Host (`hostUpdateAuthorized`/`hostModificationAuthorized` are refused).
5. P6 must package from a clean checkout whose working tree equals the committed blobs (§12).
6. Production releases should not honour the env-gated test fault hooks (R14): gate them behind a Host debug flag before
   shipping runtime-bootstrap releases to users.

## 27. Final Git state

| Item | Value |
|---|---|
| Branch | `codex/adr-0003-0005-completion` |
| HEAD | `e34995a2095d3683c225d1435136bf8fb516f0e9` (unchanged since the stage started) |
| Index | empty (0 staged entries) |
| Modified tracked files | 24 |
| Untracked files | 24 (the 23 of snapshot 3 plus this report) |
| Commits, pushes, resets, stashes, ref updates in the development checkout | none |

Untracked:

- `docs/reviews/2026-10-29-p5-e2e-1-first-real-self-repair.md`
- `docs/reviews/2026-10-29-p5-final-acceptance.md`
- `docs/reviews/2026-10-29-p5-git-2-implementation.md`
- `docs/reviews/2026-10-29-p5-git-candidate-preparation.md`
- `docs/reviews/2026-10-29-p5-managed-git-ancestry-and-host-boundary.md`
- `docs/reviews/2026-10-30-p5-closure-acceptance.md`
- `docs/reviews/2026-10-30-p5-closure-architecture-amendment.md`
- `runtime/core/engineRoot.mjs`
- `runtime/core/p5GitCandidate.mjs`
- `runtime/core/p5HostBoundary.mjs`
- `runtime/core/p5Provisioning.mjs`
- `runtime/core/p5Support.mjs`
- `runtime/host/hostError.mjs`
- `runtime/host/runtimeRelease.mjs`
- `runtime/tests/fixtures/git-interrupt-client.rs`
- `runtime/tests/fixtures/git-v0-client.rs`
- `runtime/tests/fixtures/p5-capture-engine.mjs`
- `runtime/tests/p5-crlf-identity.test.mjs`
- `runtime/tests/p5-desktop-layout.test.mjs`
- `runtime/tests/p5-e2e-support.mjs`
- `runtime/tests/p5-e2e.test.mjs`
- `runtime/tests/p5-managed-clone.test.mjs`
- `scripts/desktop-release.mjs`
- `scripts/runtime-bundle.mjs`

Snapshot-3 files edited after the regression: only `docs/reviews/2026-10-30-p5-closure-architecture-amendment.md` (documentation, §23). Every production and test file is byte-identical to the regression snapshot. Nothing is committed: committing, and choosing how to split the work, is left to the Owner.
