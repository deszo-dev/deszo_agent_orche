# P5-E2E-1 — Trusted Installed Release & First Real Self-Repair

Date: 2026-10-29

## 1. Verdict

**P5-E2E-1 VERIFIED WITH LIMITATIONS**

A test-owned installed Deszo runtime release, started and attested by the Rust Lifecycle Host in managed `run` mode, repaired
its own Engine source through the normal managed runtime: a published Parent got a genuine P3 failure, the P4 Parent Judge
requested repair, P2 opened the linked Repair, `managed-clone-v1` prepared the candidate workspace from the installed commit,
a Developer edited under Rust Process Custody, the Engine captured and committed the candidate, the real `self-repair-verify`
Gate ran the trusted verifier under Custody and issued a passing receipt, the Repair Judge accepted on the delivered dossier,
P2 approved atomically with `failed_node_retry=never`, and a durable `ProtectedSelfRepairHandoff/1` was recorded and
independently reconstructed from immutable Store objects. R1, R2 and R3 recovery pass through the same managed runner.

The verdict is **with limitations** (section 18) because the release is a `runtime`-bootstrap package produced by a new
test-owned packager, not an OS-installed desktop release; the Host is a debug build; and enrollment provisioning is an
Owner/installation step done with offline Store writes.

**Overall P5 remains `P5 IMPLEMENTATION NOT VERIFIED`.** This is not a P6 readiness claim.

## 2. Starting state

- Repository: `C:\my\2026\deszo_agent_orche`, branch `codex/adr-0003-0005-completion`, HEAD
  `e34995a2095d3683c225d1435136bf8fb516f0e9` (`p5`), with the uncommitted P5-GIT-2 work
  (`docs/reviews/2026-10-29-p5-git-2-implementation.md`, verdict P5-GIT-2 VERIFIED WITH LIMITATIONS).
- No commit, stage, reset, clean, merge, rebase or push was performed on this checkout. HEAD is unchanged.
- No Self-Repair was run on the development checkout. Every repository, installation and profile used below was created by
  the test under `.deszo/tests/custody-p5-e2e-*` and removed by the test teardown (failure diagnostics are kept under
  `.deszo/tests/failures/` by the existing test-root policy).

## 3. Release implementation

New `runtime/host/runtimeRelease.mjs` — `packageRuntimeRelease({ sourceRoot, gitTool, outDir, buildId })`:

- Refuses a dirty checkout (`git status --porcelain --untracked-files=all`) and an existing destination (never replaced).
- Source commit, SHA-256 source inventory and build-input digest come from the same `securityClosure` the protected build
  staging uses (`installedBuilds.mjs`). `buildInputsDigest(closure)` is now exported and shared by staging and the packager.
- Ships only `RUNTIME_RELEASE_PATTERN` (runtime without tests, `mcp/`, `shared/`, schemas/storage/authoring docs, three
  example workflow folders, `package.json`). Test fixtures are not packaged.
- Ships the runtime third-party closure (bare imports from the attested import graph plus their declared dependencies):
  `@modelcontextprotocol/core, @modelcontextprotocol/server, ajv, ajv-formats, fast-deep-equal, fast-uri,
  json-schema-traverse, require-from-string, typescript, zod`, 509 files; `.d.ts/.map/.md/.ts` files are excluded and
  `typescript` ships only `package.json` + `lib/typescript.js`. Their bytes are part of the attested `inputsDigest`, so the
  installed Engine never resolves an unattested ambient module.
- Every packaged byte is checked against the inventory; writes `.deszo-source-inventory.json` and a Rust-format `build.json`
  (`schemaVersion 1, runtimeApiVersion 2, bootstrap 'runtime', sourceCommit, dirtySourceDigest, inputsDigest, artifacts,
  sourceInventory`), then rechecks the closure and dependency digest and refuses if anything moved.

Source provenance is never written by hand: the Host verifies `build.json` + inventory at start and the Engine reads the Host
attestation back through `GET /api/v2/installation/source-release`.

Final run release: commit `c6dbf5249f2b654fba6d4f735f2eb9b2a767e579`, source digest
`3b8d9aeff3dbf0fd621217991fd7e8b744773c8e3cf333353988081e5757933c`, inputs digest
`bec1ad63e443920ac44885bc2cae38804538cfdbbb86943344ecbad765d9e1ef` (each test builds its own release in its own test-owned
repository, so commits differ per case; the source digest is identical).

## 4. Enrollment

- New `runtime/host/p5Provisioning.mjs` — `installP5Enrollment` validates the contract and every ref, requires the stored
  running release to equal the attested release, runs `assertP5EnrollmentCurrent` and `assertP5VerificationPolicy`, requires
  `harnessClosureDigest == attested inputsDigest`, requires both publications runnable with matching snapshot SHA, and writes
  `profile/p5/enrollment.json` with `wx` (never replaced).
- The caller-supplied record is not proof. At every startup `engine.initializeProtectedSelfRepairEnrollment` resets admission
  and enables it only from `decideProtectedSelfRepairAdmission` (runtime capability, Host certainty, live source baseline,
  verification policy + harness digest, runnable publications, workspace slot and native identity) against the Host's live
  attestation of the running package. There is no test-mode switch.
- `GET /api/v2/installation/source-release` (public, Owner read) reports the attestation and the admission decision.

## 5. Publication graph

- Repair workflow (capabilities `core-v1, loops-v1, pipeline-v1, protected-self-repair-v1`): `request → developer →
  developer-result → verify (self-repair-verify Gate) → report → repair-judge`.
- Parent workflow (workflow-judge/1): `request → worker → result`, Judge node `judge`, published with the P5 profile.
- Both published through the managed runtime API; enrollment binds `parentPublication` and `repairPublication` by id,
  version and snapshot SHA.

## 6. P3 failure

The installed release contains a genuine defect: `runtime/core/incidentLabel.mjs` returns `split('_')[0]`. The Parent worker
(`custody-p5-parent-fail`, under Custody) exits 17 with a 503 provider error; P3 records `attempt.error`, `attempt.failure_outcome`
(incident `29a8b8c9-0866-5bb3-a5be-60eee5b01fb3`, outcome `3ea7ee66-759c-4364-a942-44cedbe3d3ec` revision 1).

## 7. P4 Parent Judge and P2 link

The Parent Judge (`custody-p5-parent-judge`) receives `judge.attention_opened` (failure) and returns `request_repair` with
profile `self-repair`; P2 records `continuation.linked_repair_opened`, suspends the Parent
(`continuation.parent_suspended_for_repair`) and starts the Repair run
(`continuation.linked_repair_started`). Link `a8053e75-59c5-49e7-bce0-7c057ba74ec7`.

## 8. Developer under Custody and candidate preparation

- `self_repair.preparation_intent` → `self_repair.workspace_prepared`: `managed-clone-v1` fetched the installed commit
  `c6dbf524…` from the enrolled test remote into the slot, branch `self-repair/a8053e7559c5`.
- Fixed in passing: `ENGINE_ROOT` was undefined in `engine.mjs`, so every managed-clone preparation failed before this work.
- Developer Attempt `1300c36e-ed59-4316-910b-a8d641396f07`, Custody `4db262f2-aeef-471f-bbd9-e389608905e0`. The Developer
  edits only `<slot>/source`; its textual answer is untrusted.

## 9. Candidate capture

Normal settlement capture (`captureProtectedSelfRepairCandidateDurably`, anchor `self_repair.candidate_capture_started`),
Host boundary + derived closure check, Engine Git commit:
candidate `573272506dd45e91092f8dbed7bc095b5dfd232d06b7a5b92311f51a7e80966e`, source digest
`d0c1a56cab7cd1115744cff07f2774da234202dd1557ab4f8e3cab36024cceb9`, commit `0391ae4a4e49baf912da03868408a58d99aa1e05`,
tree `6a19afa6401845fd1fe360e64f926c67a1884feb`. `self_repair.candidate_captured` exactly once.

## 10. Gate

The real `self-repair-verify` Gate ran the trusted verifier (`runtime/verification/`) under Custody: Gate Attempt
`0d6a21a6-2c1d-44df-a1c4-d2a71cb0064c`, Custody `180c234e-471e-4010-9560-9de6ef991a4d`, verification start record
`971517ac-4c2b-4fc0-b793-8d5a319b3667`. Engine-issued passing receipt
`1f1df96af5fa96525b8d2e754a20e98bbd64f358bddc53747166e9c8aab54f94`.

Gate fixes made to reach this: expected scratch input paths include the check id; `attempt_custody.custody_id` column; the
receipt terminal check reads `state` for `ProtectedSelfRepairGateTerminalEvidence` (and the Developer seal likewise); the
receipt `execution.engineEpoch` is the start record's epoch, guarded by an unchanged lifecycle generation (this is what makes
R2 verifiable).

## 11. Repair Judge and P2 approval

The Repair Judge (`custody-p5-repair-judge`) first requests the `requiredReviewRefs` set (one `request_evidence` expansion),
then accepts on the expanded dossier. P2 records `repair.approval_recorded` atomically (approval artifact
`df8301f6-2774-45e3-b5a7-36ec263030dd`) with `failed_node_retry=never`; the Parent records `retry_not_authorized` and never
re-runs the failed node on the old binary.

Fixed in passing: P5 retention/cleanup/handoff events from `linkedRepair.mjs` carried an `origin` field the journal contract
forbids, which rolled back settlement; they are now plain `{ type, payload: { record } }` events.

## 12. Handoff

`self_repair.handoff_recorded` exactly once: handoff `74c396297183e6efd0095b7b1061e3e2cc61a325743e2b86e736314e7c6f150c`,
retention record `2c47852b-ad60-4645-8a3f-7a345aa25c81`. Authority flags `hostModificationAuthorized,
hostReplacementAuthorized, hostUpdateAuthorized, activated, binaryInstalled, productionBuilt` are all `false`.
`GET /api/v2/runs/{id}/self-repair` reports stage `retained_for_p6` (the projection now keeps an accepted never-retry handoff
`retained_for_p6` when the link is blocked from retry). `reconstructHandoff` rebuilds the candidate from only the handoff's
reachable immutable Store objects in a fresh directory and recomputes the same source identity; corrupt or forged
reconstruction inputs are refused (E1-N18).

## 13. Recovery (R1/R2/R3)

One test, one installation, one Host, four Engine processes (`15416 → 27372 → 27616 → 24744`), lifecycle generation
`90c0a48b-5aa0-40f3-8d50-c709e4c1bdf7` unchanged:

- **R1**: Engine A killed while the Developer (pid 25788) is live at its barrier; the Host relaunches the active build
  (`managed_application_relaunched`); the same Developer Attempt `6cc45bd5-…` and Custody `5391177b-…` settle; one
  Developer invocation only.
- **R2**: Engine B killed while the verifier check (pid 22284) is live; the same Gate Attempt `dd7d1b6b-…` / Custody
  `202aa63a-…` issue receipt `8fbea3b4…`; candidate captured exactly once.
- **R3**: a further Engine after completion adds no link, Attempt, candidate, commit, receipt, decision, approval or handoff;
  the only new journal events are the per-startup `continuation.reconciled` receipts. Projection stays `retained_for_p6`.

Host-facing change required for R1–R3: `lifecycle-host/src/lib.rs` now relaunches the active runtime build after an abnormal
Engine exit (`MANAGED_RELAUNCH_LIMIT = 3` within 60 s, latched `managed_application_relaunch_exhausted`, no relaunch when a
durable Lifecycle operation exists or the exit was clean). This change was made by me as Host infrastructure in the
development checkout; it is not a Self-Repair output and Self-Repair cannot touch it (section 15).

## 14. Negative matrix

| Case | Result | Layer |
|---|---|---|
| E1-N01 missing enrollment | admission closed, Parent not admitted | installed E2E |
| E1-N02 wrong release | installer refuses; Engine refuses a written foreign-release enrollment | installed E2E |
| E1-N03 tampered enrollment | admission closed | installed E2E |
| E1-N04 | bounded P5 suites (`protected-self-repair`, `p5-managed-clone`) only | bounded |
| E1-N05 Host source edit (`lifecycle-host/src/custody.rs`) | capture refused (`host_source_or_packaging`), no candidate/receipt/approval | installed E2E |
| E1-N06 Host import-closure edit (`runtime/core/transport.mjs`) | capture refused (`host_import_closure`) | installed E2E |
| E1-N07 broken candidate | captured, no passing receipt, no approval | installed E2E |
| E1-N08 forged receipt in Developer output | captured, no passing receipt, no approval | installed E2E |
| E1-N09, N10 | bounded P5-GIT-2 suites (`p5-managed-clone`, `protected-self-repair`) only | bounded |
| E1-N11 Judge accepts without dossier | decision rejected, run held for Owner, no approval | installed E2E |
| E1-N12 Parent Stop during Gate | no late acceptance or handoff | installed E2E |
| E1-N13, N14, N15 | bounded P5-GIT-2, P4 and Custody suites only | bounded |
| E1-N16 Developer requests activation | handoff authority flags false, Host executable digest unchanged, no Lifecycle operation | installed E2E |
| E1-N17 | bounded suites; HAPPY additionally asserts `retry_not_authorized` and no Parent re-run on the old binary | bounded + partial E2E |
| E1-N18 forged/corrupt reconstruction | refused | installed E2E (HAPPY) |

Note on N05/N06: P3 normalizes the Attempt error code to `process`; the durable `attempt.error` message carries the exact
refusal (`P5 candidate capture failed closed: P5 Self-Repair may not change Lifecycle Host … "<path>" (<reason>)`), which is what
the test asserts. A rejected or blocked Judge decision leaves the Repair run `waiting_for_user`; that is the fail-closed settled
outcome, not a hang.

## 15. Host immutability

- `p5HostBoundary.mjs`: Host prefixes add `docs/storage/`; `.sql` is a native/installer input; `P5_TRUST_PATHS` (boundary,
  candidate, protected-self-repair, Gate, verifier, engine, custody, linkedRepair, workflowJudge, store, utilities, validate,
  canonical, schemas, runner, the two P5 schemas) are refused as `p5_trust_boundary`, so a candidate cannot weaken what judges
  it; an underivable candidate closure is protected.
- In every test the Host executable digest is checked unchanged; no Lifecycle staging/activation operation appears in
  `operations.ndjson`. No P6 build or activation was performed; the Lifecycle Host was not repaired or updated by Self-Repair.
- The test-owned Host is the debug build of the current source, used as infrastructure.

## 16. Independent review

A fresh-context reviewer reviewed the E2E-1 change set. Findings and disposition:

| Id | Severity | Finding | Disposition |
|---|---|---|---|
| H1 | High | Runtime third-party dependencies were resolved from the ambient checkout, not attested | Fixed: dependency closure packaged and covered by `inputsDigest`; HAPPY asserts it |
| M1 | Medium | Trust modules were repairable | Fixed: `P5_TRUST_PATHS` |
| M2 | Medium | Provisioning comment overstated proof | Fixed: comment states Engine re-verifies live attestation |
| M3 | Medium | Test fixtures shipped in the release | Fixed: excluded from the package |
| L2 | Low | Relaunch could loop / race a Lifecycle operation | Fixed: latch + durable-operation check |
| L1 | Low | Receipt epoch is the admitting epoch; settling epoch only in terminal evidence | Accepted, documented here; no schema note yet |
| L3 | Low | Gap between acceptance check and commit | Accepted (single Engine transaction boundary; residual) |
| L4 | Low | Debug first-party token re-emitted on relaunch | Accepted (test-only `testSetupTokenStdout`) |
| L5 | Low | `journalCursor` heuristic | Accepted |

The reviewer did not independently verify dossier-delivery internals, the P3/P4 paths or Gate stdout replay on resume; the
fixes after review were not re-reviewed by the same reviewer. They are covered by the final run below.

## 17. Commands and results (current source)

- `node --test runtime/tests/p5-e2e.test.mjs` — **10/10 pass**, 2776 s (final run after the last fixture change).
- `node --test runtime/tests/p5-managed-clone.test.mjs runtime/tests/p5-native-source-identity.test.mjs
  runtime/tests/protected-self-repair.test.mjs` — 16/16 pass.
- `node --test` p5-verifier, engine-startup, linked-repair-isolation, parent-repair-coordination, workflow-judge-runtime,
  workflow-judge-scenarios, workflow-judge-policy, rust-host-lifecycle — 91/91 pass.
- `cargo test` (lifecycle-host) — 26/26 pass (after the relaunch change).
- `npm run docs:check` — `errors: []`. `npm run build` — built (chunk-size warning only). `git diff --check` — clean (EOL
  warnings only).
- Full `npm test` was **not** run for this source state; no historical total is reused.

Last fixes before the final run: E2E harness reads the replacement Engine's own setup descriptor after a relaunch (the old
port was stale); the settle condition treats a Judge-held `waiting_for_user` run as settled; the Developer fixture creates
missing parent directories; N05/N06 assert the durable refusal message instead of the normalized code.

## 18. Gaps and limitations

- No OS installer or desktop (Tauri) package; the release is a `runtime`-bootstrap package from the new packager, installed
  into a test-owned installation root. It is not described as a fully installed desktop release.
- Debug Host build; installation under the repository's `.deszo/tests`.
- Enrollment provisioning uses Owner offline Store writes plus an identity-only `custody-serve` Host session; there is no
  product UI for it.
- Model behavior is the deterministic Rust fixture provider, not a real LLM.
- E1-N04, N09, N10, N13, N14, N15, N17 rely on bounded suites, not the installed E2E.
- L1/L3/L4/L5 residuals above. Full `npm test` not run.

## 19. Final Git state

- Branch `codex/adr-0003-0005-completion`, HEAD `e34995a2095d3683c225d1435136bf8fb516f0e9` — unchanged; nothing staged or
  committed; no push; no merge.
- New uncommitted files from E2E-1: `runtime/host/runtimeRelease.mjs`, `runtime/host/p5Provisioning.mjs`,
  `runtime/tests/p5-e2e.test.mjs`, `runtime/tests/p5-e2e-support.mjs`, this report. Modified: `engine.mjs`, `runner.mjs`,
  `p5Gate.mjs`, `protectedSelfRepair.mjs`, `linkedRepair.mjs`, `p5HostBoundary.mjs`, `installedBuilds.mjs`,
  `lifecycle-host/src/lib.rs`, `custody-cli.rs`, `p5-managed-clone.test.mjs` (plus the P5-GIT-2 changes).
- All Git commits for test releases happened only in test-owned repositories, whose only remote is a test-owned bare
  repository; origin refs stayed `main` only.
