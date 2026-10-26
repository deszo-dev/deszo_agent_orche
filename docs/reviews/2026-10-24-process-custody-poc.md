# Process Custody proof of concept (2026-10-24)

Status of this record: implementation evidence for a Windows proof of concept. It does not accept or reject ADR-0008 or ADR-0009; both remain as recorded. Custody is an explicit experimental opt-in (`DESZO_PROCESS_CUSTODY=1`). Without it, every provider CLI keeps the existing launch path.

**Executive verdict (2026-10-25, final source): PROCESS CUSTODY POC VERIFIED WITH LIMITATIONS.**
**Recommendation: ACCEPT WITH DOCUMENTED LIMITATIONS.** H3 is closed (reproduced against the pre-fix code, fixed, and verified), definitive Host refusals are handled, and the second review's High findings are fixed. The final-source regression is green: `npm test` 730/730, `cargo test` 23/23. The open items are listed under Remaining limitations.

Earlier verdict (2026-10-24, before H3 was fixed), kept for the record: VERIFIED WITH LIMITATIONS; REQUEST CHANGES — keep the PoC open until blocking finding H3 is resolved.

## Question

Can one live, Host-owned provider invocation survive Engine replacement, recover its output and terminal result deterministically, and be terminated when its owner is lost?

## Ownership model

```
Rust Lifecycle Host ── custody service ──► per-invocation Job (kill-on-close)
        │                                       └─► provider CLI ──► descendants
        └── managed application Job ──► Tauri / Node Engine (replaceable)
```

- The CLI is created suspended by the Host, assigned to its own kill-on-close Job, and only then resumed. Its stdio pipes are created by the Host and handed only to the child; the Host keeps the parent ends.
- The managed application's Job is a different Job. Replacing or terminating the Engine or Tauri does not terminate a Custody Job.
- A Host crash closes its handles; kill-on-close ends the CLI tree. The next Host does not adopt the old process.

Implementation: `lifecycle-host/src/custody.rs` (registry, native spawn and supervision, reconciliation, service mode), `lifecycle-host/src/lib.rs` (`custody.*` routed on the Host's authenticated IPC; the managed child is unchanged), `lifecycle-host/src/main.rs` (`custody-serve`). The Engine side is `runtime/core/custody.mjs` and the `runtime/core/engine.mjs` integration points (launch, reattach, settlement, recovery).

## Protocol

Every command is one authenticated JSON line (the lifecycle capability). Commands that control a CLI also carry the Engine's **epoch** and lifecycle **generation**.

| Command | Authority | Effect |
|---|---|---|
| `custody.attach` | capability + generation | Advances the epoch; the previous Engine is fenced from then on. |
| `custody.reserve` | current epoch | Admits one attempt: allowlisted executable (canonical path and SHA-256), absolute existing workspace, filtered environment, stdin up to 48 KiB, and a deadline. Returns a single-use permit and an emergency credential. Idempotent for the same attempt and invocation digest; a different invocation is refused. The digest covers provider, executable, arguments, working directory, the stdin hash and the environment variable names. It does not cover the deadline, so a repeated reserve returns the first admission. |
| `custody.launch` | current epoch + permit | Single-use permit. Writes `spawning` before the process exists. Re-checks the working directory and the executable hash at launch. An admitted but expired permit starts nothing. Repeated launches return the existing state. |
| `custody.cancel` | current epoch | Withdraws an admission that was never launched (`admission_cancelled`); its permit becomes unusable. A launched invocation is not affected. |
| `custody.status` / `custody.read` / `custody.ack` | current epoch | Terminal and running state; output from a durable offset (≤ 32 KiB per read); monotonic acknowledgement of committed bytes. |
| `custody.stop` | current epoch | Terminates the Job; returns after the Job reports empty or a bound elapses. |
| `custody.emergency_stop` | per-attempt emergency credential only | Stops without any Engine. |

Refusals carry stable codes: `stale_engine`, `stale_generation`, `permit_refused`, `executable_not_allowed`, `cwd_unavailable`, `conflicting_invocation`, `stdin_too_large`, `not_found`, `unauthorized`, `offset_beyond_durable`, `ack_beyond_durable`. There is no adoption command; an unknown command is `unsupported`.

Environment handling: the Host removes every variable whose name begins `DESZO_LIFECYCLE_`, `DESZO_SUPERVISOR_`, `DESZO_LAUNCH_SHIM`, `DESZO_CUSTODY_` or `DESZO_TEST_DUPLICATE_LIFECYCLE`. The Engine reads its bootstrap and removes it from its own environment before any child can inherit it. Permits and capabilities are never written to the spool, the journal or a command line.

## Attempt state

`admitted → spawning → running → exited | stopped | deadline_terminated | spool_limit_exceeded | spool_failed | emergency_stopped`; `admitted → permit_expired`; `admitted → admission_cancelled` (`custody.cancel`); `spawning → launch_failed`. Host restart reconciles without relaunching: `admitted → refused_host_restart`; `spawning | running → host_lost` with `tailGapPossible = true` and `spoolComplete = false`. Terminal records are never rewritten.

## Output spool and offsets

Each stream is a durable file under the Host's custody directory. The reader writes a chunk and calls `sync_data` before the chunk counts as durable, so an offset the Engine reads is always backed by disk. A hard spool limit ends the invocation with `spool_limit_exceeded`; bytes beyond it are never silently dropped. A spool that cannot be opened, or a pipe read that fails, ends the invocation with `spool_failed` and terminates its Job.

The Engine pulls from its committed offset. It delivers bytes to its recorders first, commits them (the `attempt.log_chunk` events carry absolute `byteOffset` and `byteLength`), then acknowledges exactly the committed count. A fresh Engine resumes from the committed offset of each stream; bytes it received but had not committed are read again from the Host, so no byte is lost and none is committed twice.

A Custody stream closes as `complete` only when the Host reports a complete spool. Otherwise it closes as `partial` (or `capture_failed` if the Engine's own recorder failed), and the attempt is not accepted as a successful result.

## Resume

On restart, `recover()` leaves a Custody attempt running instead of interrupting it, and does not kill its PID. If every running attempt of a run is a Custody attempt, the run resumes; its planned-but-unstarted attempts remain schedulable. A mixed run fails closed: its Custody CLIs are stopped through the Host, and its attempts are interrupted. A Custody CLI whose node cannot be resolved is stopped and its attempt interrupted; initialization does not fail.

Resume re-enters the same settlement code as an uninterrupted attempt. The committed stdout and normalized output are replayed through the same parser without being written again; if the replayed normalized output does not equal what was committed, the attempt faults rather than guessing (`custody_resume_divergence`). A process identity that does not match the Engine's record is refused (`custody_identity_mismatch`).

A graceful Engine shutdown detaches a live Custody CLI: the CLI is neither stopped nor awaited, and the next Engine resumes it.

## Scope

Custody covers plain top-level agent attempts. Loops, map steps, managed tasks and Context-bound nodes keep the existing launch path. A Custody-scoped attempt never falls back to an ordinary launch: when the Host is unavailable, it fails. Host-bound runtimes (the Local Control Host permit path) are not combined with Custody in this PoC; the Engine refuses that combination at construction.

## Limitations

- Windows only. Other platforms compile and refuse every launch; no non-Windows run was performed.
- No graceful CLI stop protocol: a Stop terminates the Job, as the existing policy does.
- stdin is limited to 48 KiB per launch (the lifecycle IPC line is 128 KiB and stdin is carried as hex). A larger prompt needs a file handoff, which is not implemented.
- The emergency credential is stored in the Engine's database, so it is profile-local and protected only by the profile.
- The Engine's own timer for an attempt restarts after a resume; the Host's admitted deadline (timeout plus a grace) is the bound that holds across an Engine absence.
- The Host's custody service is started by `custody-serve` for proofs and diagnostics; the managed-application `run` path also serves custody when its configuration supplies a custody section.
- The provider in every proof is a deterministic fixture (`runtime/tests/fixtures/custody-cli.rs`; the Tauri proof uses `runtime/tests/fixtures/proofb-cli.rs`). No real Codex CLI is exercised by these tests.
- Remaining open and accepted items are listed under Reviewer findings and dispositions and under Remaining limitations.

## Verification record (H3, refusals and review fixes; final source, 2026-10-25)

Baseline: branch `codex/adr-0003-0005-completion`, base commit `662db49`. Nothing was staged, committed, merged, reset, rebased or pushed.

Source freeze: a SHA-256 manifest of the 25 candidate source and test files (every modified and untracked file except this document) was recorded at 07:27:35 (+03:00), before the full suite started. It was verified unchanged after the suite finished at 08:04:12 and again after the remaining commands. Only this document changed afterwards; `docs:check` and `git diff --check` were run again on it.

| Command | Scope | Result |
|---|---|---|
| `npm test` (`node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/*.test.mjs`) | Full Runtime regression. Includes Rust Host Proof A (`rust-host-lifecycle`, 5), Tauri Proof B with and without Custody (`tauri-host-proof-b`, 6), `process-custody` (18), `custody-audit` (4), `custody-replay` (5), H3 `custody-workspace-hold` (9), NR `custody-unresolved` (3), `custody-review` (2), PDE-R10 `linked-repair-isolation` (10), Parent/Repair continuation (`workflow-continuation-strict` 1, `-negative` 10), P34 (`p34-publication` 1) and AMD-19 (`amd19-authorization` 5) | **730 tests, 730 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo; exit code 0; 2173 s.** Log: `scratchpad/final-npm-test.log`. |
| `cargo test --manifest-path lifecycle-host/Cargo.toml` | Rust unit and Windows process tests | **23 passed, 0 failed**; exit 0. |
| `npm run docs:check` | Documentation and schema validation | `errors: []`; exit 0. |
| `npm run build` | Frontend build | Built; exit 0. |
| `git diff --check` | Whitespace in tracked changes | Exit 0. A trailing-whitespace scan of every untracked file found none. |

Earlier runs on intermediate source, kept for history. They do not validate the final source:
- `npm test` on the source before the review fixes: 726/727. The failure was an over-specific NR-01 assertion (the refusal can land on `custody.ack`, not only `custody.read`); it was corrected in the test.
- Focused set: 59/59.
- Pre-fix H3 reproduction: 1/1, demonstrating the defect.

## Verification record (pre-H3 source, 2026-10-24; historical)

Baseline: branch `codex/adr-0003-0005-completion`, base commit `662db49`. Nothing was staged, committed, merged, reset, rebased or pushed.

Source freshness: the full suite started at 22:08:21. Every source and test file in the working tree was last modified before that time. The only later change is this document.

| Command | Scope | Result |
|---|---|---|
| `npm test` (`node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/*.test.mjs`) | Full Runtime regression, including Rust Host Proof A, the Tauri Desktop Proof B with and without Custody, Engine recovery, P34, AMD-19, PDE-R10, Parent/Repair and ADR tests | **716 tests, 716 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo; exit code 0; duration 1514 s.** Log: `scratchpad/npm-test-final3.log`. |
| `cargo test` (in `lifecycle-host`) | Rust unit tests for permits, state, identity, spool, allowlist, generation fencing, Job containment | **21 passed, 0 failed.** Includes PC-01. Log: `scratchpad/cargo-test-final.log`. Not part of `npm test`. |
| `node --test runtime/tests/custody-replay.test.mjs` | SP-02 to SP-07 | 5 of 5 pass, run before the full suite. Log: `scratchpad/replay-run3.log`. |
| `npm run docs:check` | Documentation and schema validation | Passed; `errors: []`. |
| `npm run build` (`tsc -b && vite build`) | Frontend build | Passed. |
| `git diff --check` | Whitespace | No errors; only line-ending notices. A trailing-whitespace scan of every new file found none. |

The Tauri Proof B tests run a fresh `npm run desktop:build` on every run; the artifacts are those of the final source.

Evidence files, all under the repository's ignored `.deszo/tests/`: `custody-evidence/process-custody.json`, `custody-evidence/custody-audit.json`, `custody-evidence/custody-replay.json`, `tauri-custody-proof-b.json`.

## Real process proof

Recorded from the final run's evidence files.

- **Proof 1 (Engine replacement, Node):** Host PID 29936 (alive across replacement). CLI PID 32952, identity `custody:134373413674500290`, kept across Engine replacement. Engine PIDs 3100 (A) and 34200 (B). Offset 259 committed when Engine A was killed; 925 bytes committed and durable at the end, 17 chunks. Launches: 1. Settlements: 1. Final run state `succeeded`. The Node proof does not record the CLI's OS exit code.
- **Proof 3 (Host crash, Node):** Host PID 30444, killed (exit code `null`). CLI PID 32700 and descendant PID 27848 were both not alive after the crash. The replacement Host recorded `host_lost` and made 0 relaunches.
- **Proof 2 (Tauri A → B, real packaged builds):** One Host, PID 8772, for both builds. Application A PID 27100 and Engine A PID 24884; application B PID 34936 and Engine B PID 3488. Custody CLI PID 35352 with descendant PID 31328, one admission. Stdout durable 468 bytes = acknowledged 468 bytes; journal 9 chunks, contiguous. Generations: A `3124d3b5-…`, B `9c497d7c-…`, distinct. Activation receipt: actual activation, application responsive, Engine ready. Parent and repair runs both `succeeded`. The CLI survived the replacement, and stopping the Host ended its tree. The evidence file records the Host record as `running` when read; the test does not assert the Custody CLI's own terminal settlement.

## Proof scenarios

- **Proof 1 (live CLI survives Engine replacement): met.** Every step is covered by `Proof 1` in `process-custody.test.mjs`. The proof fails if a second CLI is created; launches were 1.
- **Proof 2 (real Tauri A → B with a live Custody CLI): met, except terminal settlement.** Real packaged artifacts, the real Host, survival, Engine B reconnect, output replay and no duplicate invocation are covered. Terminal settlement of the Custody CLI within this proof is not asserted (see the real-process record above).
- **Proof 3 (Host crash kills provider tree): met.** The Host was killed, not stopped gracefully. The CLI and its descendant ended. The replacement Host refused to adopt the old PID.
- **Proof 4 (output and receipt replay at controlled disconnection points): partially met.** Three of the five named points are instrumented and verified: after delivery before durable acknowledgement (SP-02, SP-03), after acknowledgement (SP-04), and after terminal application (SP-06). Two are not instrumented: spool durable but not delivered (SP-01), and CLI exited before the Engine applies its terminal result (SP-05). The timed-removal test (`Proof 4`) records offsets but does not force those points.
- **Proof 5 (permit and allowlist abuse): partially met.** Verified before any process starts: stale generation, conflicting invocation digest, forged permit, arbitrary executable, shell wrapper, nonexistent or redirected workspace, and a pre-existing foreign PID. Not verified: a cross-profile attempt reference against Custody. The existing `ADR6-I04` test covers cross-profile restart refusal, not Custody.

## Coverage matrix: PC-01 to PC-30

Scenario text is the completion specification's. Each row names the test that carries the result, the evidence, and the remaining limitation. Every row uses a real Host process, a real Engine process and a real fixture CLI process unless the limitation says otherwise. Coverage is **direct** when a test asserts the required result; **indirect** when only a neighbouring test covers it.

| ID | Scenario (spec) | Coverage | Test (file) | Evidence | Result | Limitation |
|---|---|---|---|---|---|---|
| PC-01 | Allowed Custody launch: one OS process starts under Host Job | Direct, OS level | `an_admitted_invocation_runs_one_contained_process_and_its_stop_drains_the_job` (`lifecycle-host/src/custody.rs`) | cargo 21/21 | Pass | Rust-level test. Node-level Job membership is inferred from Proof 3 descendant termination, not asserted separately. |
| PC-02 | Duplicate launch request: same attempt returned, no second child | Direct | `PC-02/PC-03: duplicate and concurrent launches of one admitted invocation create one process` (`process-custody.test.mjs`); Rust `duplicate_and_concurrent_launches_never_create_a_second_process` | `process-custody.json` "PC-02/PC-03 (launch)": 4 concurrent launches, 1 process | Pass | None. |
| PC-03 | Concurrent duplicate requests: exactly one process creation | Direct | Same as PC-02 | Same | Pass | None. |
| PC-04 | Wrong Engine generation: launch and control refused | Direct | `PC-04/PC-14: the previous Engine generation is fenced once a new one attaches` (`process-custody.test.mjs`); Rust `generation_tests::a_new_lifecycle_generation_fences_the_previous_one` | `process-custody.json` "PC-04/PC-14": epochs 1 → 2; `stale_engine`, `stale_generation` | Pass | None. |
| PC-05 | Expired or forged permit: launch refused | Direct | Forged: `PC-02/PC-03/PC-05/PC-06/PC-07/PC-15: abusive launches are refused and nothing is started`. Expired: Rust `an_expired_permit_never_starts_a_process` | `process-custody.json` "forgedPermit": `permit_refused`; 0 processes started | Pass | None. |
| PC-06 | Arbitrary executable: rejected by allowlist | Direct | Same grouped test (shell and relative executables); Rust `stale_engines_forged_permits_and_unapproved_launches_are_refused_before_any_process` | `process-custody.json`: `executable_not_allowed` for shell and relative | Pass | The allowlist is one fixture executable; other allowlist shapes are not exercised. |
| PC-07 | Unauthorized workspace: launch refused | Direct for a nonexistent workspace; direct for linked overlap via PC-26; direct for redirection after admission | Grouped test (`cwd_unavailable`); PC-26 tests; Rust `a_workspace_redirected_by_a_junction_after_admission_is_refused_before_any_spawn` | `process-custody.json` "workspace": `cwd_unavailable` | Pass | The Host has no workspace allowlist beyond an existing absolute directory and the linked-repair rule. |
| PC-08 | Engine disconnects while CLI runs: CLI continues | Direct | `Proof 1: a live CLI survives Engine replacement with the same process identity and settles exactly once` | `process-custody.json` "PC-08/PC-09/PC-10/PC-11/PC-29": Engine A killed at offset 259 with the CLI running | Pass | None. |
| PC-09 | Tauri/Engine replacement: same CLI PID and start identity | Direct, Engine level and desktop level | Proof 1 (identity checked after Engine B is up); `Proof B with Process Custody: a Custody-owned provider CLI and its descendant survive real Tauri A to Tauri B replacement` | Same evidence as PC-08; `tauri-custody-proof-b.json` | Pass | The Node test checks the Engine half; the desktop test uses the real application replacement. |
| PC-10 | stdout/stderr during downtime: durable replay after reconnect | Direct for stdout | Proof 1 | 925 bytes committed and durable; 259 committed when Engine A was killed | Pass | The evidence records stdout only; stderr uses the same spool path but is not reported separately. |
| PC-11 | Replayed output after crash: no duplicate Engine effects | Direct | SP-02, SP-03, SP-04 (`custody-replay.test.mjs`) | `custody-replay.json` | Pass | None. |
| PC-12 | CLI exits while Engine is absent: terminal receipt imported once | Direct | `PC-12/PC-29: a CLI that finishes while the Engine is absent is settled once by the next Engine` | `process-custody.json` "PC-12/PC-29": 1 launch, 1 settlement | Pass | None. |
| PC-13 | Duplicate terminal receipt: no duplicate Run transition | Direct | `PC-13/PC-23: a terminal outcome is applied once however often it is observed` | `process-custody.json` "PC-13/PC-23": 1 settlement, 1 run transition over 5 repeated status reads | Pass | A duplicate was produced by repeated observation, not by re-sending a receipt over the transport. |
| PC-14 | Stale Engine reconnects: fenced | Direct | Same as PC-04 | Same | Pass | None. |
| PC-15 | Unrelated existing PID supplied: no adoption | Direct | Grouped test (`foreignIdentity`: `not_found`; `adoption`: `unsupported`) | `process-custody.json` | Pass | None. |
| PC-16 | PID reuse or mismatched start time: refused | Direct | `PC-16: a recorded identity that does not match the Host process is refused, not adopted` | `process-custody.json` "PC-16": attempt `failed`, 0 relaunches | Pass | None. |
| PC-17 | Normal Stop: owned process tree terminated | Direct | `PC-17: a Stop terminates the owned process tree and records the stopped outcome` | `process-custody.json` "PC-17": CLI and descendant ended; state `stopped`; Job empty | Pass | A Stop terminates the Job; there is no graceful CLI stop. |
| PC-18 | Stop while Engine absent: Host emergency or deadline mechanism works | Direct for the deadline; direct at Host level for the emergency credential | `PC-18/PC-19: with no Engine attached the admitted deadline ends the CLI, and the permit expiry does not`; Rust `the_emergency_credential_stops_without_any_engine` | `process-custody.json` "PC-18/PC-19": `deadline_terminated` | Pass | The emergency credential is exercised at Host level only, not through the Engine. |
| PC-19 | Engine absent past permit expiry: running CLI stays alive unless its admitted constraint requires stopping | Direct | Same as PC-18 | `process-custody.json` "PC-18/PC-19": `aliveAfterPermitExpiry: true` (permit TTL 1000 ms; deadline 5000 ms) | Pass | None. |
| PC-20 | Real Host crash: Job kill-on-close terminates CLI and descendants | Direct, OS level | `Proof 3: a real Host crash terminates the CLI and its descendant, and a new Host adopts and relaunches nothing` | `process-custody.json` "PC-20/PC-21": CLI and descendant not alive after the Host was killed | Pass | None. |
| PC-21 | New Host after crash: no adoption or duplicate launch | Direct | Same as PC-20 | `process-custody.json` "PC-20/PC-21": `host_lost`, 0 relaunches | Pass | None. |
| PC-22 | Crash during launch registration: safe uncertain outcome, no blind respawn | Direct | `PC-22: a crash during launch registration is recorded as lost and never blindly relaunched` | `process-custody.json` "PC-22": `host_lost`, 0 launches at crash, 0 relaunches. Since the second review it also asserts `processTreeEnded: true` and that any CLI started before the crash is gone (F2) | Pass | Host-level; the workspace hold of such an invocation is not asserted in an Engine-level test. |
| PC-23 | Crash around terminal delivery: receipt reconciliation idempotent | Direct for idempotence; crash point SP-06 | `PC-13/PC-23` test; SP-06 (`custody-replay.test.mjs`) | `custody-replay.json` SP-06: 1 launch, 1 settlement | Pass for idempotence | **Deviation:** the run ends `interrupted` after its attempt settles once (see SP-06). |
| PC-24 | Spool reaches hard limit: explicit failure, no silent truncation | Direct | `PC-24: a spool at its hard limit is an explicit failure, not a silent truncation` | `process-custody.json` "PC-24": `spool_limit_exceeded`; 143 bytes durable at the 160-byte test limit | Pass | The limit is a test setting; the production limit is not exercised at its real size. |
| PC-25 | Split UTF-8 and partial lines: exact bytes recoverable | Direct | `PC-25: split UTF-8 and partial lines are recovered byte-exact` | `process-custody.json` "PC-25": 265 bytes; byte-exact; split character preserved | Pass | None. |
| PC-26 | Linked Repair with overlapping roots: Custody launch refused | Direct, end to end and at the real launch boundary | `PC-26: a Repair whose root overlaps its Parent is refused before any Custody admission or provider process`; `PC-26 boundary: the Custody launch path refuses an overlapping linked workspace before the Host admits anything` (`custody-audit.test.mjs`) | `custody-audit.json` "PC-26": `workspace_overlap`; 0 Custody bindings; 0 provider invocations for the Repair. Boundary: 0 admissions, 0 processes | Pass | None. |
| PC-27 | Disjoint Parent and Repair roots: valid Custody launch allowed | Direct, end to end | `PC-27: a disjoint linked Repair with a similar-prefix name is admitted and runs under Custody to settlement` (`custody-audit.test.mjs`) | `custody-audit.json` "PC-27": CLI launched under Custody and exited; spool complete; 234 bytes durable and committed; link `open` | Pass for the launch | The Repair attempt ends `failed` through the Judge contract, not through isolation. The launch is allowed; the run outcome is not a success. |
| PC-28 | Protected internal credentials: not exposed to provider | Direct | `PC-28: no lifecycle, supervisor or custody credential reaches the provider` | `process-custody.json` "PC-28": 136 environment names; 0 authority variables delivered | Pass | Checked against the fixture provider's environment, not a real CLI's. |
| PC-29 | Engine restart with completed CLI: run reconciles without launching again | Direct | `PC-12/PC-29` test; Proof 1 | `process-custody.json`: 1 launch, 1 settlement | Pass | None. |
| PC-30 | Existing non-Custody provider path: no regression | Direct | `PC-30: the default provider path without Process Custody is unchanged` | `process-custody.json` "PC-30": 0 Custody bindings, 1 launch, `succeeded` | Pass | The full `npm test` also passes (716/716 on the pre-H3 source; 730/730 on the final source). |

Every essential scenario (PC-01 to PC-16, PC-20 to PC-23 and PC-26) has direct integration or OS-level evidence. No PC scenario is classified as not verified. Two scenarios (PC-18 and PC-07) have narrower coverage than the wording suggests, as the table notes.

## Replay and crash-point audit: SP-01 to SP-08

Expected results are the completion specification's section 7.2. The fault points in `runtime/core/custody.mjs` are `after_deliver`, `after_commit`, `after_ack` and `after_settle`. SP-07 is a real Host death during a spool write.

| ID | Interruption point (spec) | Coverage | Test (file) | Result |
|---|---|---|---|---|
| SP-01 | Spool durable, not delivered → replayed on reconnect | Indirect | None instrumented. Proof 1 kills Engine A with the spool durable beyond the committed offset (259 committed; 925 durable at the end), and Engine B replays it. | Not controlled; replay observed in Proof 1 |
| SP-02 | Delivered, Engine effect not committed → replayed and applied once | Direct | `SP-02: delivered but uncommitted output is replayed and applied exactly once` | Pass: 0 committed at the crash; 565 committed at the end; 1 launch; 1 settlement; `succeeded` |
| SP-03 | Effect committed, ACK not recorded → no duplicate effect | Direct | `SP-03: committed output whose acknowledgement was lost is not applied again` | Pass: 56 committed at the crash; 565 at the end; 13 chunks; 1 launch; 1 settlement |
| SP-04 | ACK recorded, Engine disconnects → no missing effect | Direct | `SP-04: an acknowledged prefix is never missing after the Engine reconnects` | Pass: Host-acknowledged 565 = committed 565 |
| SP-05 | Provider exits before Engine receives terminal → terminal result recovered | Indirect | None instrumented. `PC-12/PC-29` exits the CLI while the Engine is absent, and the next Engine settles it once. | Terminal recovery observed; the exit is not at a named point |
| SP-06 | Terminal applied, acknowledgment lost → no duplicate terminal transition | Direct | `SP-06: a terminal outcome applied before the Engine ends is not applied again` | Exactly once: 1 launch, 1 settlement. **Deviation (superseded by P1, 2026-10-26):** the run now ends `succeeded`; the existing restart policy that interrupted it was replaced for runs with no unknown-outcome work. Whether a settled attempt should let its run complete is a policy decision not changed here. |
| SP-07 | Host dies during spool write → durable prefix valid; uncertain tail reported | Direct | `SP-07: a Host that dies during a spool write leaves a valid durable prefix and reports the tail honestly` | Pass: 85-byte durable prefix; committed bytes are a byte-exact prefix; host `host_lost`; `tailGapPossible`; `spoolComplete` false; attempt `interrupted`; stream integrity `partial` (asserted) |
| SP-08 | Spool reaches configured limit → explicit failure, no silent truncation | Direct | `PC-24` test | Pass: `spool_limit_exceeded`; 143 bytes durable; explicit failure |

## Spool and replay record (spec section I)

- **Generated bytes:** the Proof 1 fixture produced its full output as 925 bytes; the Tauri fixture produced 468 bytes up to the point of evidence capture.
- **Durably captured:** 925 (Proof 1); 468 (Tauri); 85 (SP-07, Host killed mid-write, durable prefix only); 143 (PC-24 at the limit); 265 (PC-25).
- **Delivered:** the Engine's committed bytes equal the durable bytes in Proof 1 (925) and SP-04 (565).
- **Acknowledged:** 468 (Tauri); 565 (SP-04).
- **Duplicate transport records:** none asserted. The replay tests assert byte-exact committed prefixes, not a count of duplicate transport messages.
- **Duplicate logical events:** none. Each replay test asserts one launch and one settlement.
- **Terminal receipt count:** 1 settlement in PC-12/29, PC-13/23, and SP-02 to SP-06.
- **Data loss and tail gaps:** no data loss in any passing test. SP-07 reports an unknown tail honestly (`tailGapPossible`, `partial`). PC-24 fails explicitly at the limit and never reports the spool complete.

## Reviewer findings and dispositions

An independent read-only review ran against the pre-fix source. Each finding was checked against the code before the disposition below. Line references are the reviewer's, against the pre-fix code.

Totals: 1 critical, 3 high, 4 medium, 7 low. Fixed: C1, H1, H2 (in full, including this session's manifest change), M1, M2, M3, L2, L4. Partially mitigated with residual risk: H3, M4, L1. Open and accepted: L3, L5, L6. Corrected in this note: L7.

| ID | Severity | Finding | Disposition | Evidence |
|---|---|---|---|---|
| C1 | Critical | Graceful Engine shutdown terminated Custody CLIs. | **Fixed.** `shutdown()` detaches Custody children; it does not stop them or await their exit. | Test `a graceful Engine exit detaches a live CLI instead of stopping it, and the next Engine completes the Run once`. |
| H1 | High | Map-step CLIs launched under Custody; an unresolvable node stopped Engine start. | **Fixed.** Mapped attempts are excluded from Custody scope. Resume stops and interrupts an attempt whose node cannot be resolved (`custody.mjs` `resumeCustodyAttempts`). | Test `Custody scope excludes Map-step attempts and fails closed when the Host is unavailable`. The unresolvable-node branch has no direct test. |
| H2 | High | Tail gaps and capture failures settled as a normal exit with a complete manifest. | **Fixed.** Host: a spool open or read failure records `spool_failed` and terminates the Job. Engine: an incomplete spool settles `capture_failed`. This session: the stream manifest closes `complete` only for a confirmed complete spool (`CustodyChild.spoolComplete`); otherwise `partial`. | SP-07 asserts `partial`. The Host side is covered by Rust `a_spool_that_cannot_be_opened_ends_its_cli_and_is_recorded`. The `spool_incomplete` mapping has no direct test. |
| H3 | High (blocking) | The Engine abandons a live Host CLI and releases its workspace. | **Closed 2026-10-25** (see H3 remediation; reproduced against the pre-fix code, then fixed). Disposition at the time of the first review: **Partially fixed; open.** A lost launch reply is reconciled through `custody.status`, and a started CLI is stopped. A fenced (`stale_engine`) or `unauthorized` child detaches at once instead of settling interrupted after 30 s. **Still open:** after 30 s of Host unreachability the attempt settles `interrupted` and its workspace lock is released while the Host-owned CLI may still run until its Host deadline. The lock is not held until a terminal Host record exists. This is the spec's "resource locks not released" and "invalid run advancement after uncertain process execution" pattern. | No test covers the lost-reply case. |
| M1 | Medium | The normalized stream could commit ahead of stdout, so resume diverged. | **Fixed.** Custody children defer their size and timer flushes; `commit()` flushes stdout and stderr, then the normalized stream. | Covered indirectly by SP-02 to SP-04, which replay normalized output. |
| M2 | Medium | The executable was verified only at admission. | **Fixed.** The Host re-hashes the executable at launch and refuses a changed file (`custody.rs` `launch`). | Rust `an_executable_changed_after_admission_is_refused_at_launch`. |
| M3 | Medium | A thread-spawn failure left a live, unsupervised CLI; a reader `expect` could panic. | **Fixed.** Readers and supervisor start before the record is marked running. Failure terminates the Job and records `launch_failed`. `spawn_reader` returns `Result`. | The thread-spawn failure branch has no direct test. |
| M4 | Medium (exploitability unverified) | The working directory could be replaced by a junction after the PDE-R10 check. | **Partially mitigated; residual accepted.** The Host re-canonicalizes the working directory at launch and refuses a path that changed since admission; a junction created after admission is refused before any spawn. A swap between the Host's last check and `CreateProcessW` is not closed; accepted in the completion specification's section 11. The reviewer's reparse-point rejection was not implemented. | Rust `a_workspace_redirected_by_a_junction_after_admission_is_refused_before_any_spawn`. |
| L1 | Low | Child pipe ends are inheritable until `CreateProcessW`. | **Partially mitigated; residual accepted.** Custody CLI spawn uses `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. A concurrent managed spawn that inherits handles can still hold a pipe end. | Documented window. |
| L2 | Low | The engine fell open to an ordinary launch when Custody was unavailable. | **Fixed.** A Custody-scoped attempt fails when the Host is unavailable and never falls back (`engine.mjs` launch selection). | Test in H1's row. |
| L3 | Low | A Host crash between `CreateProcessW` and `AssignProcessToJobObject` leaves a suspended CLI outside any Job. | **Accepted, documented window.** It is never adopted and never killed. The spawn order (suspend, assign, resume) is in `custody.rs` `spawn`. | No test. |
| L4 | Low | The reserve line could exceed the IPC line limit once environment and stdin were included. | **Fixed on the Engine side.** The whole request line is checked against 120 KiB before reserve (`custody.mjs` `MAX_COMMAND_BYTES`), below the 128 KiB IPC line. | Not directly tested. |
| L5 | Low | The executable is hashed while the registry lock is held. | **Open, accepted for the PoC.** A large executable delays reads and acks for all attempts. | Not measured. |
| L6 | Low | `custody-serve` is diagnostic-only: a supplied capability is accepted only in debug builds (`custody.rs` `run_service`), so a release `custody-serve` cannot be given a known capability. | **Open, accepted.** The supported route is the managed-application path. | `custody.rs` `run_service`. |
| L7 | Low (docs) | The earlier note omitted `custody.cancel`, claimed map steps were excluded when they were not, and did not say the digest excludes the deadline. | **Corrected in this note.** `custody.cancel` is in the protocol table; map-step exclusion is true after H1; the digest excludes `deadlineMs`. | This document. |

## H3 remediation: durable workspace ownership (2026-10-25)

This section records how blocking finding H3 was closed. The finding text and its earlier disposition above are kept as they were written.

### The unsafe release

In the pre-fix Engine, `CustodyChild.pump` counted Host failures from the first one, and after `UNREACHABLE_MS = 30_000` it called `finish({ signal: 'custody_unreachable' })`. The child closed, the attempt settled `interrupted`, the run went to `waiting_for_user`, and `releaseAgent` deleted the attempt's `cwd:` directory lock. Nothing told the Host to stop the CLI, so the Host-owned process kept running until its Host deadline while the Engine treated its workspace as free. Losing the Host was taken as a fact about the process when it was only a fact about the Engine's knowledge.

### Pre-fix reproduction

The reproduction ran the pre-fix Engine against the same Host binary as the fix, so the only variable was the Engine.

- **Pre-fix code:** a scratch copy whose `runtime/core` differed from the pre-H3 snapshot only by a two-line outage hook in `custodyCall`. It contained the 30 s give-up unchanged.
- **Host and fixture:** one verified Host binary for both comparisons (`deszo-lifecycle-host.exe`, SHA-256 `fa604655…`; `cargo build` was a no-op), and fixture SHA-256 `10d9bb93…`.
- **Workspaces:** scratch workspaces outside the user profile. Under the profile, the provider configuration lookup reached a home-directory project configuration and the managed-tool isolation check correctly refused the launch.

Observed (test `pre-fix reproduction: an Engine-side Host outage over 30 s frees the workspace while the original CLI still runs`; 1 of 1 pass, 39.4 s):

1. The original CLI, PID 4476 (OS start 2026-10-25T02:37:25.278Z), started; its Host record named the same process.
2. Control: a second run for the same directory under workspace id `conflict` was admitted and waited, because the original attempt held the `cwd:` lock.
3. The Engine-side outage was injected; the Host and the CLI kept running.
4. 30.6 s later the old Engine settled the original attempt `interrupted` (run `waiting_for_user`), and the directory lock passed to the control run's attempt. At that moment the original CLI was alive with the same start time, and the Host recorded it `running`.
5. After the outage cleared, a run under workspace id `conflict-2` launched CLI PID 28236 in the same physical root while PID 4476 was still the same live process.

Evidence: `.deszo/tests/repro-prefix/custody-repro-h3-uge0w7/repro-evidence.json` (ignored); log `scratchpad/repro-prefix-run4.log`. The first reproduction attempt stalled in its own teardown, not in the code under test. The Engine copy was missing `docs/examples` and failed at startup, and the test then left the Host child running because it was started outside `try/finally`. The harness was then bounded: every wait times out as INCONCLUSIVE, and teardown always runs.

### The fix

- **Durable hold (`m17`).** `custody_workspace_holds` holds one row per invocation: the custody id, attempt, run, canonical physical `workspace_root` and `state` (`held` or `released`). `custodyRecordLaunchIntent` writes it in the same transaction as the `attempt_custody` binding, after the Host admits the invocation and before the launch. It survives Engine restarts.
- **Release only on Host proof.** The Host reports `processTreeEnded` with every status (`process_tree_ended` in `custody.rs`):
  - a live invocation is `false`;
  - a terminal record is `true` only when the Job was verified empty (`drained`, recorded by the supervisor and the launch-failure path), or when no process was ever started;
  - a `host_lost` record is decided by checking the recorded PID and creation time (`identity_alive`), so a reused PID is not mistaken for the original;
  - anything else is unknown (`null`).

  `custodyReleaseIfEnded` releases a hold only on `true`, with the Host's evidence written to `evidence_json`.
- **Gated admission and dispatch.** `captureRun` refuses a run, and `tryDispatchAgent` holds back an attempt, whose resolved physical root overlaps any held root (nested directories and junction aliases overlap; disjoint roots do not). A root that cannot be resolved is refused while any hold exists.
- **An unreachable Host is waited for.** The 30 s give-up is removed. Reads, status and stop are asked again every 500 ms; nothing is settled from an unanswered call.
- **Lost launch reply.** `launchUntilAnswered` asks again with the same single-use permit; the Host returns the existing record and starts nothing. The original attempt continues instead of being stopped.
- **Stop during an outage** is retried by the pump until the Host has it (`deliverStop`).
- **Reconciliation.** A 2 s reconciler (`custodyReconcileHolds`) re-checks every held invocation that no live child of this Engine drives. It releases on the Host's proof and withdraws an admission that never launched.
- **Engine restart.** A successor reads the same holds, so admission and dispatch stay gated. It resumes the attempt and releases the hold only when the Host proves the end.
- **Host death.** A replacement Host reconciles the lost invocation to `host_lost` and proves its end from the recorded process instance. The workspace is released on that proof, and the attempt settles `interrupted`, never `succeeded`.
- **Release under failure.** An Engine that dies at `before_hold_release` leaves the hold held, and its successor releases it once.
- **Parent and Repair.** The PDE-R10 launch check (`assertLinkedRepairLaunch`) runs before admission and again before launch for Custody attempts, unchanged.

## Non-transient Host refusals (2026-10-25)

### The defects

After H3, three paths still mishandled a definitive Host refusal, such as `not_found` (the Host answering has no record of the invocation):

1. `pump` treated every non-fencing refusal like an unreachable Host and asked again every 500 ms with no limit. The attempt stayed `running` with one log line and no state change.
2. `statusUntilAnswered` (used by `finish` and `reattach`) detached the child on such a refusal and removed it from the Engine's children. The attempt stayed `running`, its process never closed, and the hold reconciler skipped the hold because it believed a child drove it. Nothing asked about the invocation again.
3. `deliverStop` counted a refused stop as delivered. Because the Host accepts a stop of an ended invocation, a refused stop had not been applied, and after a recovery it was never sent again.

A refusal is not evidence that the process tree ended: the CLI may still run under the Host that launched it. So the fix must neither settle nor release.

### The fix

- **Classification.** Transient means a transport failure, `custody_unreachable` or `custody_unavailable`; these keep the 500 ms retry. Fenced means `stale_engine` or `unauthorized`: the child detaches, and the reconciler now also detaches an unresolved child on a fenced answer. Any other refusal is definitive.
- **`unresolve()`.** On a definitive refusal from the pump, `status` or `stop`, the child stops its cycle and settles nothing. The attempt stays `running`, its directory lock stays taken, and its hold stays `held`.
- **Typed durable condition (`m18`).** `unresolved_json` and `unresolved_at` on the hold record `{ code: 'custody_unresolved', refusal, command, message, epoch, generation, at }`. A different refusal replaces the condition; the same refusal from another command or a successor Engine does not.
- **Report.** One journal `attempt.error` with code `custody_unresolved` (added to `journal-event-v2.schema.json`) is written in the same transaction, once per invocation and refusal. It is not written again while the condition stands, by a successor Engine, or after a flap within one Engine.
- **Two-second reconciliation.** The existing hold reconciler asks `custody.status` for an unresolved child every 2 s. This is the only Host traffic for the invocation while the refusal stands (NR-01 measured 5 refused commands in 10 s, all `custody.status`).
- **Identity verification and recovery.** When the Host answers, `resolveUnresolved` requires the answered process creation time to equal the attempt's recorded identity; otherwise the condition stands as `custody_identity_mismatch`. On a match it clears the condition and continues: a child that had launched resumes reading from its committed offsets, and one that had not attached yet re-attaches. The end follows the ordinary path, and the hold is released only on `processTreeEnded`. Nothing is launched again.
- **Holds without a child** (for example, a run whose CLI was abandoned at restart) now record a definitive refusal as their condition instead of skipping it silently, and clear it when the Host answers.
- **Refused Stop.** A refused stop stays pending (`stopDelivered` stays false), and the resumed pump delivers it first.
- **Test hook.** `DESZO_CUSTODY_TEST_REFUSE_FILE` names one custody id; while the file exists, the Engine's Host boundary refuses every command about that invocation as `not_found` and logs each refused command. It is inert unless the variable is set.

### Escalation semantics (what happens after the report)

- **Inspector:** the `attempt.error` is shown on the attempt (`src/Inspector.tsx` `AttemptView`, code and message) and in the run timeline (`src/App.tsx`). The user sees it when they open the run.
- **No automatic incident.** Incidents are filed only through the public incident API by an observer (`/api/v2/incidents`); nothing files one from an `attempt.error`.
- **No Judge attention.** Judge attention is created only by a registered Judge controller (`/api/v2/judge-attention`). The Engine does not create attention, and the Judge subject (`judgeSubject`) carries run state and outputs, not attempt errors. Custody never addresses the user.
- **No notification.** The run stays `running` (or `stopping`), so nothing marks it for attention beyond the error on its attempt.
- **Active versus historical.** The active condition is the hold's `unresolved_json`; it is cleared on recovery. The journal entry is history and stays after a recovery, so the Inspector still shows it on an attempt that later succeeded. A successor Engine reads the hold, not the journal, to know whether a condition stands.

This is persistent reconciliation without automatic Judge attention, by design of the PoC. It is not automatic escalation, and is not claimed as such.

## Coverage matrix: H3-01 to H3-24

Tests are in `runtime/tests/custody-workspace-hold.test.mjs` unless named otherwise. "Real" means a real Host process, real Engine processes and a real fixture CLI. "Boundary injection" means the fault is injected at the Engine's Host boundary (a file the Engine checks before each Host call) while the Host and its CLI keep running. It is not a real network or Host fault.

| ID | Requirement | Coverage | Test | Real Host/OS | Evidence | Result | Limitation |
|---|---|---|---|---|---|---|---|
| H3-01 | Host unreachable < 30 s: lock retained | Direct | `H3-01 to H3-03, H3-07 to H3-10, H3-21, H3-22: …` | Real; boundary injection (8 s) | Run stays `running` | Pass | Injection, not a real transport fault. |
| H3-02 | Host unreachable > 30 s: lock retained | Direct | Same test | Real; boundary injection (35 s) | CLI alive; attempt and run `running`; hold `held` | Pass | As H3-01. |
| H3-03 | Host reachable again: original attempt reconciles | Direct | Same test | Real | Run `succeeded`; 1 CLI invocation; hold released with `processTreeEnded` | Pass | None. |
| H3-04 | CLI exits during outage: terminal evidence reconciled once | Direct | `H3-04: a CLI that finishes during an outage …` | Real; boundary injection | Run `succeeded`; hold released | Pass | None. |
| H3-05 | Engine A dies while Host unreachable: lock persists | Direct | `H3-05/H3-06: an Engine that dies during an outage …` | Real Engine kill | Hold `held` after Engine A ended; CLI alive | Pass | None. |
| H3-06 | Engine B on same DB: lock reconstructed | Direct | Same test | Real | Engine B refuses a nested conflicting run; run `succeeded`; 1 invocation | Pass | None. |
| H3-07 | Conflicting run, same workspace: no second execution | Direct | H3-01 test | Real | Refused (409) during the 35 s outage | Pass | None. |
| H3-08 | Conflicting run, nested workspace | Direct | H3-01 test | Real | Refused | Pass | None. |
| H3-09 | Conflicting run through a junction alias | Direct | H3-01 test | Real (`mklink /J`) | Refused | Pass | None. |
| H3-10 | Disjoint workspace: allowed | Direct | H3-01 test | Real | Admitted and `succeeded` during the outage | Pass | None. |
| H3-11 | Launch succeeds, reply dropped: original attempt preserved | Direct | `H3-11: a lost launch reply …` | Real; injected loss of the first launch reply after the Host launched | 1 process creation, 1 admission; run `succeeded` | Pass | The reply is dropped at the Engine boundary, not on the wire. |
| H3-12 | Identical launch retried: no duplicate spawn | Direct | `H3-12/H3-13: a repeated identical launch …` | Real Host, raw commands | Same process id; nothing started | Pass | Host-level; no Engine. |
| H3-13 | Conflicting launch retried: deterministic rejection | Direct | Same test | Real Host | `permit_refused` | Pass | As H3-12. |
| H3-14 | Stale Engine attempts release or control: refused or ineffective | Indirect | `PC-04/PC-14` (`process-custody.test.mjs`) for fenced control; code review for release | Real Host | `stale_engine` and `stale_generation` refusals | Partial | No test has a stale Engine attempt a release. A release needs a Host status with `processTreeEnded`, which a fenced Engine is refused. The fenced-detach path in the reconciler (NR) has no test. |
| H3-15 | Normal terminal receipt: idempotent settlement and safe release | Direct | H3-01 test (H3-03 step); NR-06 (`custody-unresolved.test.mjs`); `PC-13/PC-23` | Real | Hold released once with Host evidence; 1 settlement | Pass | Repeated terminal observation, not re-delivery of a receipt over the transport. |
| H3-16 | Authorized Stop: release only after process-tree termination | Direct | `H3-16: an authorized Stop waits …` | Real; boundary injection | Run `canceled`; CLI ended; evidence `hostState: stopped`, `processTreeEnded: true` | Pass | None. |
| H3-17 | Host actually crashes: Job-owned processes die | Direct for the CLI | `H3-17/H3-18: after a real Host crash …` | Real Host kill | CLI not alive after the crash | Pass | This test's fixture starts no descendant (`descendantPid: null`); descendant death is proven by Proof 3 (PC-20). |
| H3-18 | Host crash without terminal receipt: release via verified death | Direct | Same test | Real replacement Host | Hold released only after the replacement Host reported `host_lost` with `processTreeEnded: true`; attempt `interrupted`; next run in the directory `succeeded` | Pass | None. |
| H3-19 | Host status indeterminate: lock retained, no conflicting launch | Direct | H3-02 (unreachable); NR-01/NR-02 (status refused) | Real; boundary injection | Hold `held`; conflicting run refused | Pass | A real Host losing an invocation record mid-run is not reproduced. The real Host's `not_found` code is checked directly. |
| H3-20 | Engine crashes during release: consistent ownership | Direct | `H3-20: an Engine that dies during the release transaction …` | Real Engine exit at fault point `before_hold_release` | 1 release committed by the successor | Pass | None. |
| H3-21 | Parent/Repair overlap during uncertainty: PDE-R10 preserved | Indirect | H3-01 test (physical-root overlap during an outage); PC-26 and PC-27 (`custody-audit.test.mjs`, PDE-R10 without an outage) | Real | Nested and alias refused during the outage; linked overlap refused at the Custody boundary | Partial | No test combines a linked Parent/Repair pair with a Host outage. |
| H3-22 | Original run continues after reconnect: same attempt, no duplicate effects | Direct | H3-01 test | Real | 1 CLI invocation; `succeeded` | Pass | None. |
| H3-23 | Permit expires while CLI runs: lock retained | Direct | `H3-23: the launch permit expiring …` | Real Host, permit TTL 1000 ms | Hold `held` while the CLI runs | Pass | None. |
| H3-24 | Non-Custody execution: release semantics unchanged | Indirect | `PC-30` (`process-custody.test.mjs`); the full `npm test` | Real | Default path: 0 Custody bindings, `succeeded` | Pass | No test asserts the timing of a non-Custody lock release; the unchanged suite is the evidence. |

## Coverage matrix: NR-01 to NR-08

Tests are in `runtime/tests/custody-unresolved.test.mjs`. Every NR proof uses boundary injection of `not_found` for one named invocation while the real Host and CLI keep running.

| ID | Requirement | Coverage | Test | Real Host/OS | Evidence | Result | Limitation |
|---|---|---|---|---|---|---|---|
| NR-01 | `not_found` during streaming: retry loop stops; typed condition recorded | Direct | `NR-01, NR-02, NR-04 to NR-06: …` | Real; boundary injection; the real Host's `not_found` for an unknown invocation is checked separately | Condition `custody_unresolved` / `not_found` / `custody.read` or `custody.ack`; 1 report; 5 refused commands in 10 s, all `custody.status` | Pass | Injection, not a real Host that lost the record. |
| NR-02 | CLI may still run: ownership durable; conflicting run cannot launch | Direct | Same test | Real | CLI alive; Host record `running`; attempt and run `running`; hold `held`; `cwd:` lock present; same-root run refused; disjoint run `succeeded` | Pass | None. |
| NR-03 | Engine restart: hold reconstructed, conflict blocked | Direct | `NR-03: after an Engine restart …` | Real Engine kill | Successor keeps the hold and the condition, re-takes the lock, refuses a nested run, adds no report; then completes the same CLI | Pass | None. |
| NR-04 | No duplicate launch | Direct | NR-01 and NR-03 tests | Real | 1 Host record and 1 CLI invocation for the attempt, before and after the restart | Pass | None. |
| NR-05 | Host answers again: reconciliation continues without another CLI | Direct | NR-01 test | Real | Condition cleared; same PID continues; `succeeded`; 2 invocations in total (original and disjoint) | Pass | None. |
| NR-06 | Trustworthy termination: released exactly once | Direct | NR-01 test | Real | Hold `released` with `processTreeEnded: true`; no lock left; the directory is usable by the next run | Pass | "Once" rests on the conditional update (`WHERE state = 'held'`) and the single `released_at`; no counter is asserted. |
| NR-07 | Transient failures and normal terminal outcomes unchanged | Indirect | H3-01 to H3-05, H3-16 (transient); `process-custody.test.mjs` and `custody-replay.test.mjs` (terminal) | Real | Those suites pass unchanged | Pass | No new test; the existing suites are the evidence. |
| NR-08 | Refused Stop stays pending and is delivered on recovery | Direct | `NR-08: a Stop refused by the Host stays pending …` | Real; boundary injection | A `custody.stop` was refused; the CLI stayed alive, the run was not settled and the hold was `held`; after recovery the run was `canceled` and release evidence was `hostState: stopped` | Pass | None. |

Not covered by a test: the identity-mismatch branch of `resolveUnresolved`, the fenced-detach branch of the reconciler, and the definitive-refusal record for a hold with no child.

## Second review (2026-10-25): H3, non-transient refusals and the whole candidate

A read-only reviewer ran in a fresh context, given the diff, the new files and the invariants. It ran no tests and edited nothing. It is a subagent of the same model family as the author, not an independent human reviewer. Every finding below was checked against the code before its disposition.

The reviewer found no path that releases a hold while the Custody process may still run: the only two release sites both require `processTreeEnded === true`. Its findings were mostly liveness.

| ID | Severity | Finding | Disposition | Evidence |
|---|---|---|---|---|
| F1 | High | An Engine started without Custody on a store with Custody rows called `this.custodyHost.custody` on null. A synchronous `TypeError` either aborted `initialize()` (abandon path) or was retried as an outage. | **Fixed.** `custodyCall` refuses as `custody_unavailable` when the Engine has no Custody bridge. Nothing is settled, holds stay held, and the Engine says so at startup. The workspace becomes usable once an Engine with Custody reconciles it. | Test `F1: an Engine without Process Custody keeps a Host-owned workspace held and starts normally` (`custody-review.test.mjs`). |
| F2 | High | A Host lost during `spawning` (no recorded process) reconciled to `host_lost` with `processTreeEnded: null`, so its hold could never be released. | **Fixed.** `process_tree_ended`: `host_lost` with no recorded process is ended. The spawn either never happened, its process was in the closed kill-on-close Job, or it was still suspended and never resumed. | Rust `a_terminal_record_has_ended_only_with_verified_drain_or_no_process` (extended); `PC-22` now asserts `processTreeEnded: true` and that the CLI started before the crash is gone. |
| F3 | Medium-High | `drained: false` was final, so an invocation whose Job emptied after the 10 s drain bound was never released. | **Fixed.** Within one Host, the Job of an undrained end is kept and re-checked on `custody.status`; once it is empty, `drained: true` is written durably and the Job is dropped (`recheck_drain`). After a Host restart, `reconcile` clears the stale verdict, and the end is decided by the recorded process instance, the same standard as H3-18. | Rust test covers the restart reconcile. The within-lifetime re-check has no test: a Job that outlives its 10 s drain cannot be provoked reliably. |
| F4 | Medium | A Stop pending only in memory was lost when the Engine restarted: a resumed run in `stopping` never stopped its CLI. | **Fixed.** A resumed Custody attempt of a `stopping` run carries `stopRequested`, so the Stop is issued once the child attaches. | Test `F4: a Stop pending when its Engine dies is issued again by the successor`: run `canceled`, release evidence `hostState: stopped`, 1 invocation. Node-scoped stops are not persisted. |
| F5 | Medium | Orphaned Host-owned CLIs are not stopped: abandon stops are fire-and-forget; an Engine crash between the launch intent and `spawn` records the attempt "canceled before it started"; a detached child's launch loop can still launch. | **Open, accepted.** The hold keeps the workspace safe throughout. The orphan runs unobserved until its Host deadline (timeout + 5 s), and the hold is released on the Host's proof after that. Stopping orphans from the reconciler is future work. | Code review. |
| F6 | Medium | When the Host could not write the `running` record, it returned before inserting the live entry, so a Stop could not reach the Job. | **Fixed.** The live entry is inserted first. A failed write records `spool_failed`, terminates the Job, and the supervisor records the end. | Code review; storage-failure injection is not available. |
| F7 | Medium | Holds gate run admission and agent dispatch only. Managed-task utilities and nested non-Custody work are not checked against holds, and the `cwd:` lock is by exact identity. | **Open, accepted.** Managed tasks are never Custody-scoped, and their runs are admitted through the same hold check. Within one run, a later agent dispatch waits on the hold. Concurrent nested non-Custody runs are the existing workspace policy, not changed by H3. | Code review. |
| F8 | Low | `stale_generation` was treated as a definitive refusal, not a fence, and a successor's re-attach did not clear a stale condition. | **Fixed.** `fenced()` includes `stale_generation`; a successful `reattach` clears the condition. | Code review; covered indirectly by NR-03 (the successor clears on recovery). |
| F9 | Low | `custody_unresolved` is visible only in the journal, stays after resolution, and the Inspector shows the first `attempt.error`. Journal-v1 runs get no event. A fenced detach is silent. | **Documented** (Escalation semantics). | Code review. |
| F10 | Low | After a resume, the Host deadline can fire before the restarted Engine timer, and `deadline_terminated` settles as an ordinary exit. | **Open, accepted** (existing limitation: the Engine timer restarts after a resume). | Code review. |
| F11 | Low | Migrations are versioned by index; `m17` does not backfill holds for bindings written under `m16` alone. | **Documented.** `m16` to `m18` ship together in one commit, so no store has `m16` without `m17`. Index versioning is the repository's convention. | Code review. |
| F12 | Low | An error in `finish()` (for example a store failure) is an unhandled rejection that ends the Engine. | **Open, accepted.** Fail-closed: the hold stays held, and the next Engine recovers. | Code review. |
| P1 | Medium (plausible) | The hold root is resolved by the Engine after reserve; a junction retargeted between the Host's canonicalization and the Engine's could make them differ. | **Open, accepted** with M4: a same-user swap within that window is the AR01 model. | Not reproduced. |
| P2 | Medium/Low (plausible) | `custody-serve` takes no ownership lock on its state root. | **Open, accepted** with L6: `custody-serve` is diagnostic; the managed Lifecycle Host path has its ownership lock. | Not reproduced. |
| P3 | Low (plausible) | A restarted custody service has a new port and capability that a running Engine cannot learn. | **Open, accepted.** The Engine sees an outage and waits (safe); a new Engine reconnects. | Not reproduced. |
| P4 | Low (plausible) | Resumability ignores loops, Maps and managed tasks. | **Open, accepted.** Those are outside Custody scope; existing recovery policy. | Not reproduced. |

Invariant attacks that held, per the reviewer:
- **Release gating:** the hold and binding commit in one transaction before launch, and both release sites require the Host proof.
- **Unreachable Host:** settles nothing, and a lost launch reply starts no second process.
- **Reserve-to-launch window:** PDE-R10 is checked twice, and the reconciler withdraws orphaned admissions.
- **Duplicate launch:** prevented by the binding check, digest idempotency and the single-use permit.
- **Fencing:** every control command is epoch-checked, and a fenced Engine cannot re-attach.
- **Refused Stop:** it stays pending.
- **Spool acknowledgment:** sent only after commit, with absolute offsets.
- **Unresolvable root:** blocks while any hold exists.
- **Job:** kill-on-close with no breakaway flags.

## Final safety closure — F7 / F3 / F6 (2026-10-25)

This section records the results on the frozen final candidate. Earlier text in the subsections below is kept where it still applies; where a later result supersedes it, the later result is stated and the earlier one is marked.

### Candidate identity

- Branch `codex/adr-0003-0005-completion`, base HEAD `662db49` (P33/P34 committed). Process Custody is uncommitted.
- Source and test freeze: 2026-10-25T07:54:22Z. The 28 files below are the candidate; `docs/reviews/2026-10-24-process-custody-poc.md` is documentation and is not hashed. Every hash was re-checked after the full regression: all 28 unchanged.

```text
e99a9ae12c2a0ac4fe1c9042a41556fb437df1789eb20ac51dad472312e1afd5 *docs/schemas/journal-event-v2.schema.json
a80a4ce319ee5a7d29f9a003239d42b68cf2e9700e4231c4941f720ecb3b9117 *docs/storage/m16.sql
11c239a1dde0c5390db667bb3aabf0de2c94312f199c8f6f5016648c2d11c493 *docs/storage/m17.sql
8ad90c3ca41bb6e943d408fca86280d2e43fc8af7ae5e6c1280582af96031449 *docs/storage/m18.sql
c835dfa6fc0f03397185ae52f9bbca84c99501f2228de528ed649b3b793e3180 *lifecycle-host/src/custody.rs
9d2ae562d0967cd306fc2b0ceba2316d1e27667ca5e04749647d3dead103bbe5 *lifecycle-host/src/lib.rs
f19d239d521020efc53e003a01c6d667e5205cdb40ee250a851c774c27ae48f5 *lifecycle-host/src/main.rs
befc73570636e1a452a9c21d15bce47ec1a9001eda1713e2253ffa9bec06d0e5 *runtime/core/custody.mjs
c081aa392c7c7a71cd8bb935aad1c76cafab9a9af0c4b062c14e2f6620200c34 *runtime/core/engine.mjs
1913b441955777013acdeddf3ff7a2eeca5c39cc93c35e8764e6a96d8822cef4 *runtime/core/linkedRepair.mjs
d2c640aec5aa73428fa92227aac170af9c59b2c64ea7c3857d350a738b9a6e62 *runtime/core/migrations.mjs
923d0c7672fa7846df6a6f2f5ac215beb7b191c9d08911566b361be4f06f2b02 *runtime/core/streams.mjs
9e3aa12442f021f2922ff03a7b5fb795fa1409c743df2c3243c23583292aaadb *runtime/core/taskRuntime.mjs
805a902ba8b9f3b66e226ecc2bff94923d3ecba8e841630e1b796fe5a58d5510 *runtime/host/lifecycleBridge.mjs
98f69582712a8d06beae0f2a07af9bea4a392fa37b56e3ae639d8b184ed0a5a9 *runtime/runner.mjs
26056a65ab54e518380b1adf47971f80aa7a827794e0f8f84f19cdfad6735f4c *runtime/tests/custody-audit.test.mjs
c1901fa39cd9078f6db232ee11847365970a0a0541b59737528be5318a9fb550 *runtime/tests/custody-delivery.test.mjs
62322a02a777eaab89ca3eb5e6b14f36acd3321cee3739a62ac4abd9a8c91b8a *runtime/tests/custody-replay.test.mjs
04a75aa696b561eac822d98ccfbf1331a805576ad50598ac535a437634b21bdb *runtime/tests/custody-review.test.mjs
0dbdbacd943bbcccc57d494afbbbcb2d50d1f839052c254863315cdc7dbbcc01 *runtime/tests/custody-safety.test.mjs
b4ca891eaa0ddbeda2cee92b2bcdba74c6d777eb726814a17372550955fde452 *runtime/tests/custody-support.mjs
bad11aef00c9a4b45698a817f77ed34ee595c773b3741710bd71de0b17c7f105 *runtime/tests/custody-unresolved.test.mjs
7dac621581c1a7acf27cf45fd54d61ded756bee617d7e14a3cf1e932a5ae6325 *runtime/tests/custody-workspace-hold.test.mjs
cab38b6a486ef1d434b485bf60b4fd931df6c915ab2af3e9aab599b8bbf92f57 *runtime/tests/fixtures/custody-cli.rs
b74653b8f7143345c0d738259ca1c896587f594625b5ffb6bab9e4c78fe499f1 *runtime/tests/fixtures/proofb-cli.rs
9c4b22e23dc369e13126804bd26760119cb39bba7e31f989525f01728dfd6837 *runtime/tests/p34-publication.test.mjs
f8317f55da36bdf1203950f56669fb53602a0436f671fa6221cad143817e687f *runtime/tests/process-custody.test.mjs
faf763a8b5ab282f3d22ee6802ae4d99ee884e4577f6cd8a52cb73fb5377ab1b *runtime/tests/tauri-host-proof-b.test.mjs
```

### Verification record

| Suite | Command | Passed | Failed | Skipped | Exit |
|---|---|---:|---:|---:|---:|
| Full runtime (includes Process Custody, H3, NR, review, audit, replay, PDE-R10, managed tasks, P34/AMD-19, Rust Host Proof A, Tauri Proof B, Tauri Proof B with Custody) | `npm test` | 743 | 0 | 0 | 0 |
| Rust Lifecycle Host | `cargo test --manifest-path lifecycle-host/Cargo.toml` | 23 | 0 | 0 | 0 |
| Documentation | `npm run docs:check` | — | — | — | 0 |
| Frontend | `npm run build` | — | — | — | 0 |
| Whitespace | `git diff --check` | no errors (CRLF working-copy warnings only) | | | 0 |

`npm test` took about 2373 s. The proofs named in the run: Rust Host Proof A (665), Tauri Proof B (715) and Tauri Proof B with Custody (716). Evidence files are written to the ignored `.deszo/tests/custody-evidence/` folder.

### F7 — Managed-task Delivery and Custody

**Original bypass.** The managed-task `deliver` step (`runtime/core/taskRuntime.mjs` `executeManagedTaskUtility` → `runtime/core/branchDelivery.mjs`) fetches the verified commit into the source repository (`git fetch <clone> <commit>`, with the repository as cwd) and moves the target ref (`git update-ref`). It did this without the Custody hold or launch checks, so a Host-owned CLI in the same repository could be writing while the delivery wrote. The other utilities only read committed objects or work in their own directories.

**Correction.**

- A Custody dispatch waits while an active delivery of this Engine, or a process a restart could not confirm ended, overlaps its workspace (`tryDispatchAgent` → `custodyDeliveryOverlapping`). A delivery waits while a Custody hold, a live Custody launch, or an unconfirmed process overlaps its repository (`runManagedTaskUtility`).
- Overlap is decided on resolved physical roots, so a nested directory and a junction alias overlap and a disjoint directory does not.
- The Host's reserve reply carries the canonical directory it admitted. The workspace hold is taken from that root, not from the path the Engine requested.
- A run cannot be created in a workspace where an unconfirmed process may still run (`captureRun`, 409).

**Atomic admission.** The check and the claim are one synchronous step with no `await` between them, in both `tryDispatchAgent` (`runtime/core/engine.mjs`) and `runManagedTaskUtility` (`runtime/core/taskRuntime.mjs`):

- Custody becomes visible to Delivery at dispatch, through the Custody record's `custodyCwd`, which is set before the asynchronous reserve. It becomes durable as the workspace hold, written after the Host admits the invocation and before its launch.
- Delivery becomes visible to Custody at its claim, through `deliveryCwd`. That record is in memory only.
- Two Engines on one runtime root cannot both run: `runner.lock` is taken before the Engine is constructed (O_EXCL, with a stale-PID check that fails closed).
- Engines on different roots that share one Host and one repository are not coordinated (limitation F7-L3).

**Restart.** The rules are as follows.

- Under standalone containment, `recover()` kills each surviving managed command whose recorded creation time matches, before scheduling resumes. A survivor that still lives blocks overlapping Custody and delivery work, and new runs in its workspace, until it ends.
- A survivor under supervised (`tauri-job`) containment is not killed by the Engine: its Job belongs to the supervisor. It is gated the same way, from the durable attempt row, but no F7 test runs this path (limitation F7-L2).
- A survivor whose creation time cannot be read is not killed; it blocks only if its attempt was running at the restart.

**Tests** (`runtime/tests/custody-delivery.test.mjs`, 8/8 in the full run). Real Engine, real Lifecycle Host, real managed task, and a Host-owned fixture CLI that writes into its workspace.

| ID | Scenario | Outcome | Evidence (UTC) |
|---|---|---|---|
| F7-01 | Custody CLI holds the same directory under another workspace id | Delivery waited; published after the Host's proof | CLI pid 26924; released 08:00:34.496; first repository write 08:00:41.916 |
| F7-02 | Delivery targets a junction alias of the held directory | Delivery waited | CLI pid 11812; released 08:00:55.699; first write 08:01:02.853 |
| F7-03 | Delivery targets a nested directory of the held root | Delivery waited | CLI pid 25776; released 08:01:17.257; first write 08:01:23.935 |
| F7-04 | Delivery targets a disjoint directory | Delivery completed while the CLI kept running | CLI pid 11976, alive at delivery; both succeeded |
| F7-05 | Delivery already running when the Custody run is submitted | CLI started after the delivery ended | Delivery ended 08:02:06.694; CLI started 08:02:06.930 (236 ms later) |
| F7-06 (delivery-first) | Both submitted together on one root | No overlap | CLI pid 8736; released 08:02:55.331; first write 08:03:01.374; delivery ended 08:03:02.885 |
| F7-06 (custody-first) | Both submitted together on one root | No overlap | CLI pid 27832; released 08:03:15.355; first write 08:03:22.077 |
| F7-07 | Restart record present for the workspace | New run refused (409); queued attempt not dispatched while recorded; dispatched after the record cleared | 1 provider invocation while recorded; 2 after clearing |

F7-06 note. Both submission orders were admitted Custody-first in this run, so submission order did not decide the winner. The test asserts non-overlap for whichever side wins. A delivery admitted first is covered by F7-05, which sequences it.

**Evidence of the race ordering.** Within one Engine, the synchronous claim decides the order. The test observes the winner from the timeline rather than forcing it.

**Changes made in this round** (each followed by a passing run):

- Termination of a Host-owned CLI's Job is repeated on each supervisor tick while a stop is recorded.
- A leader that exits while the Host has not proven its process tree ended is not accepted as a result (see F3).
- The Engine's own timeout for a detached Host-owned CLI is cleared on shutdown. Before this, a detached CLI's timer kept the test process alive after its test ended.

### F3 — Leader exit before Job drain

**Results** (`runtime/tests/custody-safety.test.mjs`, 5 tests, all passing in the full run).

- **F3-01/03/04 (Host).** Leader pid 18336 exited; descendant pid 22504 kept writing. The record stayed undrained and `processTreeEnded` stayed false while the descendant lived. A failed drain-proof write left the answer unchanged. After the proof was written, the answer became `processTreeEnded: true`.
- **F3-01/02 (Engine).** Leader pid 3508, descendant pid 10160. The workspace hold stayed `held` while the descendant lived and was released after the Host proved the Job empty. The attempt is now `waiting_for_user` (see the change below), not `succeeded`.
- **F3-05 (restart).** Leader pid 9780, descendant pid 13780 died with its Host (kill-on-close). The replacement Host decided the end by the recorded process instance, released the hold, and launched nothing again.

**Changes made in this round**, as a result of the independent review:

- A terminal record that cannot be written at the leader's exit no longer reports the drain as proven. The Job stays undrained, so a later status proves it and writes the proof durably first (`supervise`, `recheck_drain`).
- An exit whose tree the Host has not proven ended settles as an unaccepted attempt (`tree_not_ended`), not as a result. The hold stays until the proof. This changes F3-01/02 from `succeeded` to `waiting_for_user`.

**Limitations.** The attempt's result is the leader's, and the workspace hold carries the protection of any descendant. In production the supervisor terminates an undrained Job within a 5 s drain window, so an undrained end is expected only if termination itself fails.

### F6 — Running-record persistence after process creation

**Sequence** (`lifecycle-host/src/custody.rs` `launch`, `native::spawn`):

1. Record `spawning` durably.
2. Create the Job.
3. Create the CLI suspended, assign it to the Job, then resume it.
4. Start the readers and the supervisor.
5. Insert the live entry.
6. Write the `running` record.
7. Reply.

**Fault boundary.** `testFailRunningRecordAfterMs` lets steps 1–4 run for real (the CLI and its descendant are alive), then fails step 6.

**Results** (same file).

- **F6-01/04 (Host).** The launch was refused as `storage_unavailable`. Leader and descendant both ended, with no survivor. The end is recorded `spool_failed` with `processTreeEnded: true`.
- **F6-03 (Engine and restart).** The attempt failed with no recorded process id. The hold was released only after the Host proved the end. A restart launched nothing again, and the Host kept the recorded end.

**Changes made in this round:**

- After a failed running-record write, the in-memory state reverts to `spawning`, so a repeated launch can no longer report `running`.
- A pre-spawn write failure leaves a record with no process. Such a record is decided as ended, because no process of the invocation was recorded. Before this, the hold was never released (reviewer finding 8).

**Limitations.**

- F6-02 (a failed `TerminateJobObject`) cannot be injected. It is reviewed by code only.
- An Engine crash between the Host's launch reply and the Engine's `running` transition leaves a Host-owned CLI with a hold and no observer until its admitted deadline. This is the accepted F5 boundary, and it has no test.
- An abandon stop is sent once, and a stop that fails at startup is not retried (F5).

### Independent review

- **Reviewer.** One fresh-context, read-only subagent with no access to the author's conclusions. It did not run the tests. It reviewed the working tree at a state about 10:35 local time, before several fixes below. Its findings were checked against the code before any change.
- **Re-review.** The post-review changes were verified by the passing suites above but were not re-reviewed by a fresh reviewer. A re-review is recommended before staging.

**Dispositions.**

| # | Severity (reviewer) | Finding | Disposition |
|---|---|---|---|
| 1 | High | Restart under supervised containment leaves a Delivery writing without a record | Mitigated. Survivors are identified and gate Custody, delivery and run creation until they end; the gate is re-derived from the durable attempt row. Residual: the window between a command's process creation and its recorded process id, and the supervised path has no F7 test. Limitation F7-L2 |
| 2 | Medium | An unreadable process identity is treated as no survivor | Fixed. Such a process blocks its workspace if its attempt was running at the restart, and is never killed |
| 3 | Medium | Restart record is in memory only | Fixed. Survivors are read from the durable attempt rows at every start, so a survivor stays visible after its attempt is interrupted |
| 4 | Medium | Run creation and dispatch ungated by unconfirmed processes | Fixed for unconfirmed processes (409, F7-07). `recoveryBlocked` still gates only run creation, as at HEAD |
| 5 | Medium | A delivery's git child can outlive its leader | Open. Managed commands run without a Job in standalone mode. Limitation F7-L1 |
| 6 | Medium | An exited attempt is accepted without a tree proof | Fixed: fail-closed, `tree_not_ended` (F3-01/02 now `waiting_for_user`) |
| 7 | Medium | A failed `TerminateJobObject` is final | Fixed: termination is repeated each tick while a stop is recorded. The failing call itself is code-review only (F6-02) |
| 8 | Medium | A pre-spawn write failure can leave the hold unreleasable | Fixed: a record with no recorded process is decided as ended. Code-verified; not fault-injected |
| 9 | Medium | Crash between the Host's launch reply and the Engine's `running` write | Accepted under F5. The CLI is Host-owned and bounded by its deadline; no test |
| 10 | Medium | An abandon stop is sent once | Accepted under F5 |
| 11 | Low | Over-blocking when a workspace cannot be resolved | Accepted. Conservative; blocks only the unresolved workspace |
| 12 | Low | Hold root taken from the requested path | Fixed: the Host's canonical admitted root |
| 13 | Unverified | Two roots sharing one Host and repository | Open. Limitation F7-L3 |

### Remaining limitations (F7 / F3 / F6)

- **F7-L1 (delivery descendants).** A managed command's completion is its leader's close. Git waits for its own helpers, but a detached descendant is not proven ended. Which git child could detach was not verified.
- **F7-L2 (supervised restart).** Under `tauri-job`, survivors are gated but not terminated, and no F7 test runs that path. A managed command whose process was created but not yet recorded is not identified. The delivery claim is not durable before its launch.
- **F7-L3 (cross-root).** Two runtime roots that share one Host and one repository do not coordinate. `runner.lock` covers one root only. Not verified by a test.
- **F7-L4 (aliases).** UNC `\\localhost\C$` and `subst` aliases are not tested.
- **F7-L5 (ordinary agents).** A managed-task delivery takes only its `delivery:` lock, not the `cwd:` lock. An ordinary agent run in another workspace id on the same root is therefore not serialized with a delivery. This is outside S1, which covers only Custody CLIs.
- **F5 (accepted).** Orphaned Host-owned CLIs run unobserved until their admitted deadline, with their workspace held (see F6).

### Correction to earlier text

The line "F7: holds gate run admission and agent dispatch only" in *Open defects and gaps (2026-10-25, accepted for the PoC)* is superseded. Holds now gate managed-task deliveries too, and unconfirmed restart processes are gated as above. The limitations that remain are the ones listed above.

## Final acceptance gate — supervised restart, forced races, re-review (2026-10-25)

This section records the second closure round on a new frozen candidate. For the current candidate, it replaces these parts of the section above:

- the candidate identity and its manifest;
- the regression totals;
- the F7-06 note;
- the F7-L1, F7-L2 and F7-L3 dispositions.

The text above is kept as the record of that round.

### Candidate identity

- Branch `codex/adr-0003-0005-completion`, base HEAD `662db49`. Process Custody is uncommitted.
- Source and test freeze: 2026-10-25T11:59:48Z, 33 files. This document is not part of the candidate and is not hashed.
- Every hash was re-checked after the full regression, and all 33 were unchanged.

```text
e99a9ae12c2a0ac4fe1c9042a41556fb437df1789eb20ac51dad472312e1afd5 *docs/schemas/journal-event-v2.schema.json
a80a4ce319ee5a7d29f9a003239d42b68cf2e9700e4231c4941f720ecb3b9117 *docs/storage/m16.sql
11c239a1dde0c5390db667bb3aabf0de2c94312f199c8f6f5016648c2d11c493 *docs/storage/m17.sql
8ad90c3ca41bb6e943d408fca86280d2e43fc8af7ae5e6c1280582af96031449 *docs/storage/m18.sql
c835dfa6fc0f03397185ae52f9bbca84c99501f2228de528ed649b3b793e3180 *lifecycle-host/src/custody.rs
9d2ae562d0967cd306fc2b0ceba2316d1e27667ca5e04749647d3dead103bbe5 *lifecycle-host/src/lib.rs
f19d239d521020efc53e003a01c6d667e5205cdb40ee250a851c774c27ae48f5 *lifecycle-host/src/main.rs
0a9c44a9d86c531932a887fd035212d53714a8e8d42c550309c1cd567c044a01 *runtime/core/branchDelivery.mjs
6476ba1472eae634a9687d0cbffcd7f815b26a3ff046ead10fbf48c580c580a8 *runtime/core/custody.mjs
ce78b6d8ae85970e5e3c0521bf9be5e752f58748514aa630a0b85c54e2e4a334 *runtime/core/engine.mjs
1913b441955777013acdeddf3ff7a2eeca5c39cc93c35e8764e6a96d8822cef4 *runtime/core/linkedRepair.mjs
d2c640aec5aa73428fa92227aac170af9c59b2c64ea7c3857d350a738b9a6e62 *runtime/core/migrations.mjs
923d0c7672fa7846df6a6f2f5ac215beb7b191c9d08911566b361be4f06f2b02 *runtime/core/streams.mjs
09eb5ba4593cb2da930d8a23964ecec869d18bd113845efd188d108a5e2a4874 *runtime/core/supervision.mjs
77edba15171f510c474a06608ef5b73330fb6165ef1b7425fd8b5932ac45e21a *runtime/core/taskProcesses.mjs
3ae5bb2169cb3018562b1f78525ed65b5c41d2a4cf58ae80eb6ff06a56f2f93a *runtime/core/taskRuntime.mjs
805a902ba8b9f3b66e226ecc2bff94923d3ecba8e841630e1b796fe5a58d5510 *runtime/host/lifecycleBridge.mjs
98f69582712a8d06beae0f2a07af9bea4a392fa37b56e3ae639d8b184ed0a5a9 *runtime/runner.mjs
26056a65ab54e518380b1adf47971f80aa7a827794e0f8f84f19cdfad6735f4c *runtime/tests/custody-audit.test.mjs
3e6d4faf97dcceb9542f21f0b587193098be677e3e7e169a148971c7c6ef89a2 *runtime/tests/custody-delivery.test.mjs
62322a02a777eaab89ca3eb5e6b14f36acd3321cee3739a62ac4abd9a8c91b8a *runtime/tests/custody-replay.test.mjs
04a75aa696b561eac822d98ccfbf1331a805576ad50598ac535a437634b21bdb *runtime/tests/custody-review.test.mjs
0dbdbacd943bbcccc57d494afbbbcb2d50d1f839052c254863315cdc7dbbcc01 *runtime/tests/custody-safety.test.mjs
b4ca891eaa0ddbeda2cee92b2bcdba74c6d777eb726814a17372550955fde452 *runtime/tests/custody-support.mjs
bad11aef00c9a4b45698a817f77ed34ee595c773b3741710bd71de0b17c7f105 *runtime/tests/custody-unresolved.test.mjs
7dac621581c1a7acf27cf45fd54d61ded756bee617d7e14a3cf1e932a5ae6325 *runtime/tests/custody-workspace-hold.test.mjs
125bc79b5eb7ea67bad36bffc7bc0d7cc6afe9bd11cc37258c8517ade7940284 *runtime/tests/f7-detached-maintenance.test.mjs
cab38b6a486ef1d434b485bf60b4fd931df6c915ab2af3e9aab599b8bbf92f57 *runtime/tests/fixtures/custody-cli.rs
d59702e5d378d7a19068023d9687b47a731bfe7a9e91f3e0d1d5b7945fd87044 *runtime/tests/fixtures/proofb-cli.rs
9c4b22e23dc369e13126804bd26760119cb39bba7e31f989525f01728dfd6837 *runtime/tests/p34-publication.test.mjs
f8317f55da36bdf1203950f56669fb53602a0436f671fa6221cad143817e687f *runtime/tests/process-custody.test.mjs
4904377b7595414e2365250e4953ca01087add06e1e8888605e2f4234d22338c *runtime/tests/tauri-host-proof-b.test.mjs
c26d6998b001128f2dfe1c36b8aa8c7d9b82919870e0f2adc3cb60c3c2d51423 *src-tauri/src/main.rs
```

### Verification record (final candidate)

| Suite | Command | Passed | Failed | Skipped | Exit |
|---|---|---:|---:|---:|---:|
| Full runtime | `npm test` | 750 | 0 | 0 | 0 |
| Rust Lifecycle Host | `cargo test --manifest-path lifecycle-host/Cargo.toml` | 23 | 0 | 0 | 0 |
| Documentation | `npm run docs:check` | — | — | — | 0 |
| Frontend | `npm run build` | — | — | — | 0 |
| Whitespace | `git diff --check` | no errors (CRLF working-copy warnings only) | | | 0 |

`npm test` took about 2960 s. Each of these passed inside that one run:

- F7 same, alias, nested, disjoint and reverse.
- F7-06 Race A, Race B and Race C; F7-07; F7-08; F7-09.
- F7-L1 control and production.
- F3-01/03/04, F3-01/02 and F3-05; F6-01/04 and F6-03.
- Rust Host Proof A, Proof B, and Proof B with Process Custody.
- Both supervised containment proofs.
- The supervision suite, including the controller-paused Root Stop.

### F7-L2 — supervised restart (the High finding)

**Lifecycle**, in the order the acceptance request gives it:

1. A delivery is admitted by the synchronous check-and-claim in `runManagedTaskUtility` (`runtime/core/taskRuntime.mjs`).
2. Ownership is the in-memory `deliveryCwd` record and the `delivery:` lock.
3. The process is created. `runTaskCommand` calls `launchContained` (`runtime/core/supervision.mjs`), which spawns the launch shim inside the runtime's Job. The shim waits for the supervisor's rendezvous, is assigned to the run Job, and only then starts Git. Every process the runtime creates is in the runtime's Job from the moment it exists.
4. The PID and creation identity are written in the spawn handler (`runtime/core/taskProcesses.mjs`, `runtime/core/engine.mjs`), after the OS has created the process.
5. The delivery writes.
6. Engine A ends, or Tauri A is replaced.
7. Containment. The desktop shell's watcher (`src-tauri/src/main.rs` `watch_generation`, then `contain_exit`) terminates the runtime's Job and waits until it has no active process. If that wait fails, `uncertain` is set and no runtime starts again in that application. When the application itself ends, its Job is kill-on-close, and the Host stops Tauri A's tree before activating Tauri B (`managed_process_tree_stopped`).
8. Engine B. In Host-managed mode a second runtime cannot start in the same application, because the lifecycle capability is one-time (`main.rs` consumes it at the first spawn). A successor Engine is therefore a new application, started by the Host after the old tree has stopped.
9. Survivors. Under the shell none remains, because the Job decides, not the database. `recoverSurvivors` and `unconfirmedWorkspaces` are a second line of defence for standalone and headless runs.
10. A conflicting Custody dispatch can happen only in a successor, and is decided by the F7 gates.

**Crash windows:**

- **W0, before process creation:** there is nothing to contain.
- **W1, created but no identity written:** covered by the runtime's Job, not by the PID.
- **W2, after the identity write:** covered by the Job, and by `recover()` under standalone containment.

**Real desktop proofs** (`runtime/tests/tauri-host-proof-b.test.mjs`, "Supervised containment"). Both ran on the release `deszo.exe` in a Host-managed installation, with a supervised fixture writer that wrote Git objects and refs into its repository every 250 ms. The times are milliseconds after the runtime was observed to end.

| Scenario | Application / runtime PID | Writer / descendant PID | Attempt row at the end | Writes | Last write | Tree observed gone | Writes after |
|---|---|---|---|---:|---:|---:|---:|
| Runtime killed during the write | 35032 / 15580 | 26304 / 35308 | `running`, process_id 31256 (the launch shim) | 6 | −271 | +65 | 0 |
| Crash in W1 (identity withheld 8 s, runtime ended) | 17292 / 34036 | 22232 / 26376 | `scheduled`, process_id NULL | 13 | −195 | +94 | 0 |

In the second run, the attempt row named no process while the writer was writing, and the shell still ended the writer and its descendant. The absent PID was not treated as evidence that no process existed.

**Not covered by these proofs:**

- No successor Engine runs inside them.
- The writer is an agent CLI launched through the same `launchContained` path that a delivery's Git commands use; it is not a managed-task delivery.
- The conflicting Custody dispatch is proven at the Engine level (F7 suite), not under Tauri.
- How a parent Job counts members of nested Jobs (`ActiveProcesses`) was not measured on its own. Nested members did end in both proofs.
- A standalone desktop without a Host can start a runtime again in the same application. It is contained by the same Job, but no proof covers it.

**Disposition:** closed for the Host-managed Windows desktop path. Standalone and headless runs remain best-effort; there, an absent PID is not resolved.

### F7-06 — forced admission races

The barrier (`afterBarrierWork`, `runtime/core/custody.mjs`) is called after each side's synchronous check-and-claim, in `tryDispatchAgent` for Custody and in `runManagedTaskUtility` for delivery. It records the claim order and can hold a claim. In production it calls the work directly.

| Race | Winner, from claim order | Evidence (UTC, 2026-10-25) | Overlap |
|---|---|---|---|
| A, Custody claim held | Custody, then delivery | Claimed 12:07:37.140; CLI 12:07:42.454 to 12:07:52.695 (release); first repository write 12:08:00.849; delivery ended 12:08:02.287 | none |
| B, delivery claim held | delivery, then Custody | Delivery ended 12:08:20.417; CLI started 12:08:20.635 | none |
| C, submitted together, no hold | Custody, then delivery | Second claim taken 210 ms after the first side's release (12:08:43.814); first write 12:08:51.272 | none |

Each race started the CLI exactly once, and no reservation was left behind.

**Related proofs:**

- **F7-08:** a Custody run in a nested directory waits behind a Custody claim on its parent. The parent was released at 12:09:05.389; the nested CLI started at 12:09:05.685.
- **F7-09:** a Stop while a Custody claim is held ends the attempt `canceled`, with no provider invocation.
- **F7-07:** while a restart record stands, a new run is refused (409) and a queued run is held. The watch re-dispatches the queued run within a second of the record clearing, with no manual pump.

### F7-L1 — detached Git child

- **Finding.** `git fetch` runs `git maintenance run --auto`, then `git gc --auto` (GIT_TRACE on Git 2.39.2). Where Git can daemonize, `gc --auto` detaches and keeps repacking after the fetch returns. Whether it detached on this Windows build was not established: one sample found Git processes 4 s after a default fetch had returned, but they were not attributed to it.
- **Correction.** The source-repository fetch passes `-c gc.auto=0 -c maintenance.auto=false fetch --no-auto-gc --no-auto-maintenance` (`SOURCE_FETCH_CONFIG`, `SOURCE_FETCH_OPTIONS` in `runtime/core/branchDelivery.mjs`). `update-ref` starts no child (traced). The flags need Git 2.29 or later.
- **Tests** (`runtime/tests/f7-detached-maintenance.test.mjs`).
  - The control shows that the default fetch starts maintenance.
  - The production fetch starts none.
  - After the production fetch returns, no Git process attributable to it remains: none whose parent is the fetch, none running a maintenance command, none working on the repository.
- **Earlier failure.** In an earlier full run, the sampler counted an unrelated Git process from another application as a survivor. The test now attributes each process, and logs unrelated ones rather than asserting on them.
- **Disposition:** resolved.

### F7-L3 — cross-root coordination

**Enforced boundary.**

- One lifecycle Host per desktop installation. Its ownership lock is keyed on the installation root (`lifecycle-host/src/lib.rs`), and a second profile is refused (Proof B).
- One Engine per runtime root (`runner.lock`).

**Not coordinated.**

- Separate installation roots.
- A standalone desktop without a Host.
- Headless runners on other roots that use the same repository.

The product contract is one installation with one active profile, so shared-repository execution across roots is unsupported, and no global exclusivity is claimed.

### Independent reviews in this round

Three fresh-context, read-only reviewers looked at successive candidates. None ran tests.

| Round | Finding | Disposition |
|---|---|---|
| 1 | High: a root Stop recorded Host-owned CLIs as contained | Fixed: the run-Job proof and the Host-owned tree proof are separate, and both are required |
| 1 | High: a Custody claim on an overlapping root was not visible to a nested Custody dispatch | Fixed (`launching` gate; F7-08) |
| 1 | Medium: a Stop before a Custody launch launched the CLI first | Fixed (F7-09) |
| 1 | Medium: a zero-owned Stop recorded `stopped` before checking containment | Fixed |
| 1 | Medium: no re-dispatch when an unconfirmed process ended | Fixed (`watchUnconfirmed`) |
| 1 | Medium: orphaned Host CLI after a crash between the hold and `running` | Accepted under F5 (bounded by its admitted deadline, workspace held) |
| 1 | Medium: absent PID in standalone mode | Accepted: standalone is best-effort |
| 1 | Medium: no containment off Windows | Accepted: desktop supervision is Windows-only |
| 1 | Low: Tauri start failures did not drain the Job | Fixed |
| 1 | Low: evidence wording overstated | Fixed |
| 1 | Low: single termination after the leader exits | Accepted: bounded by the drain and a terminate |
| 1 | Low: concurrent-start race in `lock.mjs` | Accepted limitation |
| 1 | Low: ordinary agents and deliveries are not excluded from each other | Accepted (F7-L5) |
| 2 | Medium: the Stop proof missed Host-owned trees outside its snapshot | Fixed: every held binding of the run counts |
| 2 | Low: supervisor failure, admission left after a lost reply, two Tauri early returns, the containment label | Fixed |
| 2 | Low: PID reuse in the unconfirmed list | Accepted: fails closed and clears at restart |
| 3 | Medium: the Stop proof re-probed bindings already proven | Fixed: only held holds count |
| 3 | Low: unconfirmed containment label, bound attempts missing from the evidence, the null probe, reattach of a withdrawn admission, a comment | Fixed |

The final full regression then found one regression from the round-3 fix. A Stop with an empty launch set was labelled `windows-job`. It now records containment `none`, with the run Job still asked whether any member remains. That one-function change was covered by the full regression, but no fresh reviewer re-reviewed it.

### Remaining accepted limitations (final)

- **F5:** an orphaned Host-owned CLI after an Engine crash, in the window between the Custody hold and the `running` transition. It runs until its admitted deadline, with the workspace held.
- Standalone and headless runs are best-effort. An absent PID and a delivery's detached descendants are not resolved there.
- Desktop supervision exists on Windows only.
- Cross-root execution is uncoordinated (F7-L3).
- Ordinary agents and deliveries in one repository are not excluded from each other (F7-L5).
- PID reuse in the unconfirmed list fails closed.
- A concurrent-start race exists in `runner.lock`.
- The source fetch needs Git 2.29 or later.

### Verdict for this round

**PROCESS CUSTODY POC VERIFIED WITH LIMITATIONS.**

- No Critical or High finding is open.
- The supervised restart finding is closed for the Host-managed Windows desktop path, with direct evidence.
- The delivery-first race is proven (Race B).
- The limitations above are documented boundaries, not open defects.

## runner.lock — exclusive Engine ownership (2026-10-25)

This section closes the `runner.lock` concurrent-start limitation, which the acceptance gate above accepted. For the current candidate it replaces these parts of that section:

- the "One Engine per runtime root" entry under F7-L3;
- the `runner.lock` entry under the remaining limitations;
- the candidate identity and the regression totals.

The text above is kept as the record of that round.

### The defect

`runtime/lock.mjs` created `runtime/runner.lock` with an exclusive create (`open(…, 'wx')`). That step was atomic; recovering a stale lock was not.

1. A starter that found the file read its `pid` and called `process.kill(pid, 0)`.
2. If that process had ended, it deleted whatever file was now at the path and created its own.

Two starters recovering one stale file could interleave so that both returned as owner:

1. Both read the stale owner.
2. A deleted the stale file and created its lock.
3. B deleted A's fresh lock and created its own.

Nothing held the file while an Engine ran, so nothing could prevent the deletion.

**Reproduction before the fix.** Each case used real `runner.mjs` processes on isolated roots, with a test-only barrier around the lock's file calls.

| Case | What happened |
|---|---|
| RL-02 | Both Engines passed the lock. B then failed with `database is locked`, and its release deleted the only lock while A kept serving. |
| RL-02b | Both Engines initialized over one store (same `storeId`) and both served. |
| RL-02c | After the race, an ordinary third start with no barrier came up alongside A. |
| RL-06 | The second Engine's start-up recovery killed the first Engine's live CLI and marked its Run `interrupted`; the first Engine then crashed with `database is locked`. |

**What did not prevent it.** None of these is an ownership mechanism:

- SQLite failed only writes that happened to overlap, at random.
- The `resource_locks` primary key blocked only an identical key.
- The Custody Host epoch fenced Custody commands, not the Engine.
- The F7 delivery and Custody gates are kept in memory, separately in each Engine.

### The fix

Ownership is now an exclusive SQLite lock on a dedicated database, `runtime/runner.lock.db`. The owning connection holds it for the Engine's whole life.

**Acquisition.** `acquireRuntimeLock` in `runtime/lock.mjs`:

1. Opens the lock database.
2. Runs `PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE`.
3. Records its owner id in an append-only `owners` table.
4. Commits.

In EXCLUSIVE locking mode the connection keeps the lock after `COMMIT` until it is closed. Any other connection, in another process or the same one, is refused at once with SQLITE_BUSY.

**Retries.** Two starters can meet in SQLite's lock ladder and both be refused. A refused attempt closes its connection, so up to five attempts are made, 20–80 ms apart.

- A retry cannot admit a second owner, because the file lock decides every attempt.
- A starter that is still refused fails with the existing message, "A runtime already owns this data directory…".
- A damaged lock database (SQLITE_CORRUPT or SQLITE_NOTADB) fails with a message saying to delete it once no runtime is running.

**Lifetime and isolation.**

- The runtime store (`store/state.sqlite`, WAL) is not touched, and no long transaction is held on it.
- The connection stays in a module-level set until its release closes it, so ownership never depends on a caller keeping the release closure alive.
- The operating system releases the lock when the process ends, however it ends.
- There is no PID check for ownership, and no file is ever deleted to take ownership.

**Order.** `runtime/runner.mjs` takes the lock first, as before, then:

1. the owner token;
2. the Engine;
3. `initialize()` and `recover()`;
4. serving.

**Marker compatibility.** `runtime/runner.lock` keeps the `{ "pid": …, "id": … }` format but is no longer authoritative.

- Only the owner writes it, after taking the lock. It writes a temporary file and renames it over the target, replacing any marker that a crashed owner left behind.
- The Windows interactive launcher (`runtime/host/native/InteractiveLauncher.cs`, `profileQuiescent`) reads only `pid`, and its behaviour is unchanged.
- A missing marker admits nobody while the lock is held.

**Runtimes from before this change.** An older runtime holds only the marker.

- While the lock is held, the new owner compares the existing marker against `owners`. A readable marker that no owner of this database ever wrote, naming a live process, is treated as such a runtime. The start is refused and the marker is left in place.
- A marker written by any earlier owner of this database never blocks a start, whatever crashed since. LCK-REUSE covers a failed start followed by PID reuse.
- A reused PID behind a genuinely old marker refuses, as the old lock did.
- An unreadable marker, such as an old runtime's empty file in the instant between create and write, is replaced.

**Release.** Release is idempotent.

1. It deletes the marker only while the marker still carries this owner's id. A marker that cannot be removed is reported on stderr and left in place.
2. It closes the connection last.

**Shutdown ordering in `runner.mjs`.**

- `close()` releases the lock only after `engine.shutdown()` and the HTTP server have finished. It is memoized, so a second Stop request waits for the same shutdown.
- The start-failure paths (the catch around Engine start, the HTTP listen and the Host `runtime.ready` call) shut the Engine down before releasing.
- If the shutdown itself fails, the lock is kept until the process ends, because CLIs or timers may survive.

**Test-only crash points.** `DESZO_RUNNER_LOCK_TEST_FAULT=after-ownership` and `=after-marker` end the process with code 97. They are inert unless set, and absent from the packaged runtime.

### Semantics verified on this platform

These were verified on Windows 11 with Node.js v22.20.0 and SQLite 3.50.4 (`node:sqlite`). The desktop shell runs the system Node.

- **After `COMMIT`:** another process's `BEGIN EXCLUSIVE`, a plain read and `PRAGMA journal_mode` all fail with SQLITE_BUSY (errcode 5).
- **During activity:** this still holds after the owner has run 300 WAL store transactions, spawned child processes and run garbage collection.
- **Release by close:** closing the owning connection releases the lock while the process keeps running.
- **Release by kill:** killing the owning process releases it.
- **Path aliases:** the same root named through a junction or in another letter case is the same lock. The lock is on the file, not on the path string. The reviewer also checked `\\?\` and 8.3 short paths.
- **Hot journal:** a hot `runner.lock.db-journal` left by a crash mid-commit is rolled back by the next owner (reviewer probe).
- **Simultaneous contenders:** 25 of 25 rounds of 10 contenders produced exactly one owner, both with the proposed sequence and with a write inside the transaction.

### Tests (`runtime/tests/runner-lock.test.mjs`)

All tests run real processes on disposable roots under `.deszo/tests`. Contenders at lock level import `runtime/lock.mjs`. Engines are started from `runtime/runner.mjs`.

The forced cases use a test-only `--import` hook (`runtime/tests/fixtures/runner-lock-*.mjs`). For `runtime/lock.mjs` only, it does two things:

- holds every contender at the lock database until all of them have arrived;
- records every marker write, rename and removal.

Only processes the tests start are stopped. All Engine tests except RL-FIX-10 run with Process Custody off.

| Test | Result | Evidence |
|---|---|---|
| LOCK-SEM | pass | Held after COMMIT and through activity; refused for every other process; released by close (process alive) and by kill; a missing marker still refused. |
| LOCK-RACE (RL-FIX-02/08 at lock level) | pass | 24 rounds, 176 contenders released together, half of them with a stale marker for a dead process: one owner every round, and the marker is always the winner's. |
| LCK-05 | pass | A release leaves a marker that is not its own and still releases the lock. A late repeated release removes nothing of the successor's and leaves it the owner. |
| RL-FIX-01 | pass | 3 rounds of 10 Engines held together at the lock: one initialized, served and ran a Run to `succeeded`. Nine exited with "already owns", published no connection and performed no marker operation. The only Run in the store is the winner's. |
| RL-FIX-02 / RL-FIX-08 | pass | 4 rounds, stale marker for a dead process, two Engines released together: one owner. The loser performed no marker operation. The winner performed exactly `write` and `rename` after taking the lock, and deleted nothing. |
| RL-FIX-03 / LCK-04 | pass | The owner was killed during a 30 s Run. Its CLI ended with it (on Windows Node keeps children in a kill-on-close Job). The stale marker remained. The successor started with no file removed, replaced the marker, settled the old Run `interrupted` and ran a new Run to `succeeded`. |
| RL-FIX-04 / LCK-07 | pass | A graceful shutdown removed the marker. The lock database remained, and the next Engine started over it. |
| RL-FIX-05 / LCK-01 / LCK-02 | pass | Crash after the lock and before the marker (exit 97, no marker); crash after the marker and before the Engine (exit 97, stale marker, no store). The next Engine started and replaced the marker. |
| LCK-03 | pass | Engine construction failed on a damaged store. The marker was removed, the lock was released, and the root started once the store was removed. |
| LCK-03b | pass | Listen failure (EADDRINUSE) after initialization. The Engine was shut down (its store directory could be deleted), then the lock was released. |
| LCK-LEGACY | pass | A live process holding only an old-style marker: a new Engine was refused and the marker was not replaced. After the process ended, the root started. |
| LCK-REUSE | pass | Owner crash, then a start that crashed after taking the lock, then the crashed owner's PID pointed at a live process: a valid successor still started. |
| RL-FIX-06 | pass | The owner's marker was deleted. A second Engine was refused and wrote no marker, and the owner kept serving. |
| RL-FIX-07 / LCK-08 | pass | Three Engines were started against an owner running a 30 s CLI, and all were refused before recovery. The owner's attempt stayed `running` with the same process, creation time, resource locks and marker; no attempt was interrupted; the Run `succeeded`. |
| LOCK-ALIAS | pass | A junction alias and an upper-case spelling of the root were refused. |
| RL-FIX-10 | pass | Without Custody: every test above. With Custody, an owner running a Host-owned CLI: the second Engine was refused before it attached, the Host epoch stayed 1, and the Run `succeeded` with one launch. |
| RL-FIX-09 | full regression | Tauri start, supervised containment and Host-managed replacement are the existing desktop proofs in `tauri-host-proof-b.test.mjs` and `rust-host-lifecycle.test.mjs`. No new desktop test was added. |

**The original reproductions, rerun on the fixed lock.** The scratchpad harness was unchanged; its file-call barrier no longer applies, because the lock makes no such calls.

| Case | Result |
|---|---|
| RL-02 | A ready; B refused with "already owns". |
| RL-02b | A ready; B refused. The lock named A throughout. |
| RL-02c | A ready; B refused. The plain third start C was refused while A ran. The lock named A. |
| RL-06 (standalone) | B was refused before recovery. A's CLI stayed alive, its attempt stayed `running`, its resource lock stayed, and the Run `succeeded`. |
| RL-06 (Custody) | Same result; the Run `succeeded` with one launch. |

### Limitations

- **Platform.** Verified on Windows only. On Linux and macOS SQLite uses POSIX advisory locks; the same code relies on them, but they were not tested. There, any of the following would break the lock:
  - deleting or renaming `runner.lock.db` or its directory while an Engine runs, which lets a second Engine lock a new file;
  - any other open and close of the file inside the owning process;
  - a network file system that does not honour the locks.

  On Windows SQLite opens the file without delete sharing, so it cannot be removed while it is held.
- **Scope.** The lock covers one runtime root. Separate roots, and separate installations that share one repository, are still uncoordinated (F7-L3).
- **Marker.**
  - The marker can outlive a crashed owner. It records the last owner, not a live one.
  - The launcher still treats a missing marker as quiescent (`profileQuiescent`), so a marker deleted by hand while an Engine runs is reported as quiescent there. `ProfileRecovery` re-checks before it acts. The launcher was not changed.
  - A temporary marker file can remain after a crash between its write and its rename.
- **Mixed versions.** An older runtime that starts at the same moment as a new one is not excluded. It does not take the database lock, and either may replace the other's marker. Run one version per root.
- **Embedded starts.** A failure in `startRunner` after the lock is taken but outside the paths listed above (the route-inventory check, `runtimeIdentity()`, the connection-file write) keeps the lock until the process ends. The command-line runtime ends the process.
- **Lock database size.** The `owners` table gains one small row per start and is not pruned.

### Independent review

A fresh-context, read-only reviewer reviewed the change, then the fixes for its findings, then the fix for its re-review finding. It ran its own probes in its own temporary directory, and none of the repository tests.

| Round | Finding | Disposition |
|---|---|---|
| 1 | Nothing Critical, High or contract-breaking. Verified: lock lifetime; exclusivity, including extended-length and 8.3 short paths; crash recovery, including a hot journal; retries; marker format; ordering; Tauri and Host replacement; canonicalization; packaging. | — |
| 1 | Low: the launcher treats a missing marker as quiescent | Accepted and documented; the launcher is unchanged |
| 1 | Low: a failed Engine shutdown still released the lock | Fixed: `shutDownThenRelease` keeps the lock when the shutdown fails |
| 1 | Low: in embedded starts, some failures after the lock (route inventory, identity, connection file) bypass cleanup | Accepted and documented; the lock is kept, which fails closed |
| 1 | Low: a second `close()` returned before the first finished | Fixed: `close()` is memoized |
| 1 | Low: a marker that could not be removed made a graceful exit fail | Fixed: reported and left in place; the lock is still released |
| 1 | Low: temporary marker files can remain after a crash | Accepted and documented |
| 1 | Low: a damaged lock database blocks startup | Fixed: the message says what to delete |
| 1 | Low: the POSIX caveats were undocumented | Fixed: documented in `lock.mjs` and above |
| 1 | Low: a runtime from before this change was excluded in one direction only | Fixed: a live old-style marker refuses the start (LCK-LEGACY) |
| 1 | Info: raw error codes; test names claiming more than they prove | Fixed: codes are masked; LCK-05 and RL-FIX-03 corrected; LCK-03b added |
| 2 | Medium (liveness): the old-runtime check compared the marker with the last owner only. A failed start followed by PID reuse could then block every later start | Fixed: append-only `owners` table; only a marker that no owner ever wrote can refuse (LCK-REUSE) |
| 2 | Info: an unreadable marker is replaced | Accepted and documented |
| 3 | The `owners` fix was confirmed against the reviewer's own reproduction. Nothing new was Critical, High or contract-breaking. | — |

The final candidate below includes every fix. The focused suite passed 16/16 on it before the freeze, and again inside the full regression.

### Correction to earlier text

The F7 section above says that two Engines on one runtime root "cannot both run" because of `runner.lock`. That was not true of the lock it described: its stale-PID recovery could admit two Engines, as shown above. It is true of the lock in this candidate.

### Candidate identity

- Branch `codex/adr-0003-0005-completion`, base HEAD `662db49`. Process Custody and this fix are uncommitted.
- Source and test freeze at 2026-10-25T17:16:25Z, 39 files:
  - the 33 files of the previous candidate, with `runtime/runner.mjs` changed;
  - `runtime/lock.mjs` and `runtime/tests/runner-lock.test.mjs`;
  - four `runtime/tests/fixtures/runner-lock-*.mjs` files.
- This document is not part of the candidate and is not hashed.
- All 39 hashes were re-checked after the full regression, and none had changed.

```text
e99a9ae12c2a0ac4fe1c9042a41556fb437df1789eb20ac51dad472312e1afd5 *docs/schemas/journal-event-v2.schema.json
a80a4ce319ee5a7d29f9a003239d42b68cf2e9700e4231c4941f720ecb3b9117 *docs/storage/m16.sql
11c239a1dde0c5390db667bb3aabf0de2c94312f199c8f6f5016648c2d11c493 *docs/storage/m17.sql
8ad90c3ca41bb6e943d408fca86280d2e43fc8af7ae5e6c1280582af96031449 *docs/storage/m18.sql
c835dfa6fc0f03397185ae52f9bbca84c99501f2228de528ed649b3b793e3180 *lifecycle-host/src/custody.rs
9d2ae562d0967cd306fc2b0ceba2316d1e27667ca5e04749647d3dead103bbe5 *lifecycle-host/src/lib.rs
f19d239d521020efc53e003a01c6d667e5205cdb40ee250a851c774c27ae48f5 *lifecycle-host/src/main.rs
0a9c44a9d86c531932a887fd035212d53714a8e8d42c550309c1cd567c044a01 *runtime/core/branchDelivery.mjs
6476ba1472eae634a9687d0cbffcd7f815b26a3ff046ead10fbf48c580c580a8 *runtime/core/custody.mjs
ce78b6d8ae85970e5e3c0521bf9be5e752f58748514aa630a0b85c54e2e4a334 *runtime/core/engine.mjs
1913b441955777013acdeddf3ff7a2eeca5c39cc93c35e8764e6a96d8822cef4 *runtime/core/linkedRepair.mjs
d2c640aec5aa73428fa92227aac170af9c59b2c64ea7c3857d350a738b9a6e62 *runtime/core/migrations.mjs
923d0c7672fa7846df6a6f2f5ac215beb7b191c9d08911566b361be4f06f2b02 *runtime/core/streams.mjs
09eb5ba4593cb2da930d8a23964ecec869d18bd113845efd188d108a5e2a4874 *runtime/core/supervision.mjs
77edba15171f510c474a06608ef5b73330fb6165ef1b7425fd8b5932ac45e21a *runtime/core/taskProcesses.mjs
3ae5bb2169cb3018562b1f78525ed65b5c41d2a4cf58ae80eb6ff06a56f2f93a *runtime/core/taskRuntime.mjs
805a902ba8b9f3b66e226ecc2bff94923d3ecba8e841630e1b796fe5a58d5510 *runtime/host/lifecycleBridge.mjs
cc85535a8a304735eeb6f80ea7b3b3abe4dc91a648a8ffa9f47b12a888c02757 *runtime/lock.mjs
832aa811a3656ee6ea8d386e844923c451bbf5b43ba8f4481f8a9454bfac6a39 *runtime/runner.mjs
26056a65ab54e518380b1adf47971f80aa7a827794e0f8f84f19cdfad6735f4c *runtime/tests/custody-audit.test.mjs
3e6d4faf97dcceb9542f21f0b587193098be677e3e7e169a148971c7c6ef89a2 *runtime/tests/custody-delivery.test.mjs
62322a02a777eaab89ca3eb5e6b14f36acd3321cee3739a62ac4abd9a8c91b8a *runtime/tests/custody-replay.test.mjs
04a75aa696b561eac822d98ccfbf1331a805576ad50598ac535a437634b21bdb *runtime/tests/custody-review.test.mjs
0dbdbacd943bbcccc57d494afbbbcb2d50d1f839052c254863315cdc7dbbcc01 *runtime/tests/custody-safety.test.mjs
b4ca891eaa0ddbeda2cee92b2bcdba74c6d777eb726814a17372550955fde452 *runtime/tests/custody-support.mjs
bad11aef00c9a4b45698a817f77ed34ee595c773b3741710bd71de0b17c7f105 *runtime/tests/custody-unresolved.test.mjs
7dac621581c1a7acf27cf45fd54d61ded756bee617d7e14a3cf1e932a5ae6325 *runtime/tests/custody-workspace-hold.test.mjs
125bc79b5eb7ea67bad36bffc7bc0d7cc6afe9bd11cc37258c8517ade7940284 *runtime/tests/f7-detached-maintenance.test.mjs
cab38b6a486ef1d434b485bf60b4fd931df6c915ab2af3e9aab599b8bbf92f57 *runtime/tests/fixtures/custody-cli.rs
d59702e5d378d7a19068023d9687b47a731bfe7a9e91f3e0d1d5b7945fd87044 *runtime/tests/fixtures/proofb-cli.rs
47d11b17de15e5acc7f6dbf3ec69ff9467fe6d26bf39eadfca1c4b72f3f0f85e *runtime/tests/fixtures/runner-lock-fs.mjs
5c6741913889c9c893f9e1d1c54db82bb545e1d14e848198b6da03d32556f57c *runtime/tests/fixtures/runner-lock-hooks.mjs
a57058f2506d08705cac55f69d43c75ff83c1fb1f527d629464329d8fdc00e3d *runtime/tests/fixtures/runner-lock-register.mjs
f6bc9f5e43edafe15c9c2ce6fd152edf3f92ba37d45c2cf940be93e12d181a68 *runtime/tests/fixtures/runner-lock-sqlite.mjs
9c4b22e23dc369e13126804bd26760119cb39bba7e31f989525f01728dfd6837 *runtime/tests/p34-publication.test.mjs
f8317f55da36bdf1203950f56669fb53602a0436f671fa6221cad143817e687f *runtime/tests/process-custody.test.mjs
82cef82df67e038b1f99cff01bca15c89e325868fdc706dfc8c4d4b432a49b89 *runtime/tests/runner-lock.test.mjs
4904377b7595414e2365250e4953ca01087add06e1e8888605e2f4234d22338c *runtime/tests/tauri-host-proof-b.test.mjs
c26d6998b001128f2dfe1c36b8aa8c7d9b82919870e0f2adc3cb60c3c2d51423 *src-tauri/src/main.rs
```

### Verification record (final candidate)

| Suite | Command | Passed | Failed | Skipped | Exit |
|---|---|---:|---:|---:|---:|
| Full runtime | `npm test` | 766 | 0 | 0 | 0 |
| Rust Lifecycle Host | `cargo test --manifest-path lifecycle-host/Cargo.toml` | 23 | 0 | 0 | 0 |
| Documentation | `npm run docs:check` | — | — | — | 0 |
| Frontend | `npm run build` | — | — | — | 0 |
| Whitespace | `git diff --check` | no errors (CRLF working-copy warnings only) | | | 0 |

`npm test` ran from 17:16:37Z to 18:09:24Z, about 3147 s. It includes the 16 `runner-lock` tests and every proof listed for the previous candidate, among them:

- the F7, F3, F6 and SP Custody suites;
- Rust Host Proof A, Proof B (Tauri A to Tauri B) and Proof B with Process Custody;
- the negative desktop Host cases;
- both supervised containment proofs.

### Disposition

The `runner.lock` concurrent-start limitation is **closed**. On Windows, at most one live Engine owns a runtime root, including in these cases:

- simultaneous starts;
- simultaneous recovery of one stale marker;
- crashes before and after the marker;
- graceful shutdown and process death;
- replacement, including Tauri A to Tauri B under the Host.

The limitations listed above remain.

## Adversarial checklist (spec section 13)

The spec's search list was applied to the final source. Items marked open are the remaining findings above.

- Process ownership: suspend-then-assign ordering, kill-on-close and the handle list are as designed. L3 is the known window.
- Admission: no duplicate launch for one attempt; permit single-use; epoch and generation fences hold in launch, reserve and stop. Lost-reply handling is partial (H3).
- Output: spool write, sync and limit ordering and the monotonic acknowledgement are as designed. H2 is fixed.
- Security: M2 and M4 are fixed or mitigated; L2 is fixed. The Owner Token boundary is covered by the existing `Owner Token cannot cross into internal Host routes` test in the full suite.
- Engine: C1 and H1 are fixed. Duplicate settlement is guarded. The resource-lock release after an uncertain outcome is H3, still open.

## Portability (spec section L)

The Windows implementation is the only one that performs launches. The Rust `native` module has a non-Windows stub that refuses every launch, and the Node side refuses Custody launches when the Host is unavailable. Non-Windows compilation and refusal were not tested in this run. Real macOS or Linux containment would need its own process-group or cgroup-based implementation, its own identity source (the Windows start time is not portable), and its own spool and permit tests. None of that is claimed here.

## Remaining limitations (spec section N)

- **Accepted security-model limitation:** AR01, same-user Full Access. A process running as the same user can act on Host-owned processes. Not mitigated by this PoC.
- **Windows-only proof coverage:** all launch, identity, Job and desktop evidence is Windows-only.
- **Known spool crash-tail limitation:** SP-07 reports an unknown tail as partial. A Host that dies mid-write can leave the tail unknown; the Engine does not recover it.
- **Unimplemented provider integrations:** no real Codex CLI run; deterministic fixtures only. No graceful CLI stop; no file handoff for stdin above 48 KiB.
- **Missing cross-platform support:** no macOS or Linux implementation.
- **Actual open defects (as of 2026-10-24):** H3 (blocking); the lost-reply case had no test. **Both are closed as of 2026-10-25:** H3 by the H3 remediation; the lost reply by `H3-11`.
- **Open defects and gaps (2026-10-25, accepted for the PoC):**
  - F5: orphaned Host-owned CLIs run unobserved until their Host deadline, with the workspace held.
  - F7: holds gate run admission and agent dispatch only.
  - F10: deadline classification after a resume.
  - F12: an error in `finish()` ends the Engine (fail-closed).
  - P1 to P4 (not reproduced).
- **Escalation is not automatic.** A `custody_unresolved` condition is shown in the Inspector and recorded on the hold. It creates no incident, no Judge attention and no notification; the Engine reconciles it every 2 s for as long as it stands.
- **Liveness boundaries:**
  - A workspace stays held, with no manual unlock, while no Host can prove the end: a Host that is gone for good with no replacement, an Engine running without Custody, or a Job that never empties.
  - An undrained end is re-checked within one Host lifetime, and is decided by the recorded process instance after a Host restart.
- **Evidence boundaries:**
  - **Fault injection, not real faults.** H3 outages and NR refusals are injected at the Engine's Host boundary. A real Host losing an invocation record mid-run is not reproduced, though the real Host's `not_found` code is checked directly.
  - **Repeated observation, not re-delivery.** Duplicate terminal handling is proven by repeated observation, not by re-delivering a receipt over the transport.
  - **stdout only.** PC-10 reports stdout, not stderr.
  - **Survival, not settlement.** Proof B with Custody proves the CLI survives Tauri replacement, not its terminal settlement after the replacement.
  - **Branches without tests:** the within-lifetime drain re-check, the identity-mismatch branch of `resolveUnresolved`, the fenced-detach branch of the reconciler, the definitive-refusal record for a hold with no child, and the F6 write-failure path.
- **Partial proof coverage:** Proof 4 (SP-01 and SP-05 not instrumented); Proof 5 (cross-profile reference not tested for Custody); Proof 2 (no terminal settlement of the Custody CLI recorded in the Tauri evidence); H3-14 and H3-21 partial; H3-24 and NR-07 indirect.
- **Deviation (superseded by P1, 2026-10-26):** SP-06 run now ends `succeeded`, because its accepted outcome is not repeated and the run finishes from its durable state; see [the P1 review](2026-10-26-p1-durable-workflow-continuation.md).
- **Accepted residuals:** M4 (junction swap between the last check and `CreateProcessW`), L1, L3, L5, L6.
- **Review independence:** both reviews were run by read-only subagents of the same model family as the author, in fresh contexts. No independent human review has been done.
- **Test-suite scope:** the Rust unit tests are not part of `npm test`; they were run separately (21/21 on the pre-H3 source, 23/23 on the final source).

## Addendum (2026-10-26): terminal settlement under F3

A latent defect was found after the Stage 1 real-Codex proof: a Host stop-family end (`stopped`, `deadline_terminated`, `emergency_stopped`) with an unproven process tree and exit code 0 could settle an attempt as successful. The corrected classification, the error-code mapping and the full verification status are in [2026-10-25-real-codex-process-custody-stage1.md](2026-10-25-real-codex-process-custody-stage1.md) (addendum of 2026-10-26) and in [the candidate manifest](evidence/2026-10-26-f3-terminal-fix-source-manifest.json). The full regression has no terminal result on the frozen candidate, so the correction is not yet fully verified.
