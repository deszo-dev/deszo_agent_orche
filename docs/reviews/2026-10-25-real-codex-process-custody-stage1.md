# Real Codex CLI Execution Through Process Custody — Stage 1

## Verdict

**REAL CODEX CUSTODY VERIFIED — STAGE 1 COMPLETE.** A real Codex CLI process reached a Codex-invoked READY barrier, remained alive while Engine A was terminated, was reattached by Engine B through the same Rust Host invocation, and completed the original Run after the harness released the gate. The independent disposable-project verification passed.

The machine-readable record is [2026-10-25-codex-custody-real.json](evidence/2026-10-25-codex-custody-real.json). Two intervening harness failures are preserved separately: [workflow timeout validation](evidence/2026-10-26-codex-custody-real-preflight.json) (rejected before a provider launch) and [stale cutover offset observation](evidence/2026-10-26-codex-custody-real-cutover-failure.json) (one real task reached READY, but Engine A was not replaced).

## Architecture map

| Responsibility | Existing implementation | Stage 1 change |
|---|---|---|
| Provider selection | Agent node configuration and Engine provider detection in runtime/core/engine.mjs | Custody-scoped Codex checks installed CLI capabilities and fails closed if the required options are absent. |
| Prompt preparation | Engine resolves the published workflow prompt and persists its invocation artifact. | No second model or prompt rewriting was added. |
| Invocation | runtime/core/adapters.mjs builds argv and stdin for each CLI. | Custody uses codex exec --json, direct executable launch, workspace-write sandboxing and ephemeral execution. |
| Authentication | The Codex CLI owns its existing CODEX_HOME login and credential storage. | Detection requires an existing ChatGPT login; no credential file or token is read into Deszo. |
| Process ownership | runtime/core/custody.mjs and lifecycle-host/src/custody.rs own admitted provider children. | Codex is launched directly by the Rust Host after executable path/hash verification and a single-use permit. |
| Streaming | Host spool, Engine journal chunks and byte-offset acknowledgement. | Codex JSONL events are normalized while original stdout/stderr bytes remain replayable. |
| Event normalization | Provider parser in runtime/core/adapters.mjs; journal writes in runtime/core/engine.mjs. | Codex thread, turn, item, error and terminal events are retained; malformed JSONL becomes provider_protocol. |
| Terminal settlement | Engine attempt/run transitions and persisted invocation bindings. | Added typed unsupported_cli and custody_unavailable outcomes, plus provider protocol/auth/quota/rate-limit classification. |
| Recovery | Host-owned process registry, generation fencing, spool replay and durable workspace holds. | The real Codex Engine B reattachment and byte-offset continuation are verified below; Tauri desktop replacement remains fixture-only. |
| Stop | Engine Stop routes through custody.stop to the Host-owned process tree. | The integration does not use a shell wrapper or a separate process supervisor. |

## Installation and invocation

The observed environment was Windows 11 Home Single Language, build 26300; Node v22.20.0; Codex CLI 0.164.0-alpha.11.1. The installed CLI was a native executable at the redacted path `%LOCALAPPDATA%/OpenAI/Codex/bin/<build>/codex.exe`. The Host admitted it by canonical path and SHA-256. The Host executable used for the real attempt had SHA-256 `65f0e26ea5840c8ebd78c0ec5dc0a58d2116e135c8861eb2a7ae81bf2171d5ff`.

The local CLI's version, root help, exec help and login status were inspected before launch. The selected protocol is non-interactive `codex exec --json`, because it provides a single process and structured JSONL directly consumable by the existing Host spool. The real invocation used the requested model `gpt-6-luna`; it did not silently substitute another model.

Custody arguments included `--ask-for-approval never`, `--ignore-user-config`, `--ignore-rules`, `--sandbox workspace-write`, `--ephemeral`, `--json`, and the CLI's direct executable path. The observed user configuration selected Windows sandbox mode `elevated`; the invocation explicitly reapplied only that Windows backend setting. The filesystem policy remained `workspace-write`. Ordinary non-Custody Codex detection does not inspect this Custody-only setting. Arbitrary cmd.exe or PowerShell provider wrappers are not used.

Authentication was an existing ChatGPT sign-in confirmed by `codex login status`. The adapter forces ChatGPT login selection and the OpenAI model provider. It does not read, store, print or inject OAuth credentials, API keys or Deszo Owner Tokens. The exact-version neutralizer is registered for the user scope only; the entry does not claim project-scope support.

The workflow continues using the existing agent-node provider/model fields, for example `provider: codex` and an explicitly configured model. Process Custody is currently an experimental runner/Host bootstrap selected through `DESZO_PROCESS_CUSTODY=1`; it is not a new UI configuration flow. A missing Host bridge fails closed instead of falling back to an ordinary Node-launched CLI.

## Event and result handling

Each Codex JSONL object is retained as a normalized provider event. `thread.started` supplies the session id; `turn.started` supplies model metadata; agent-message `item.updated` and `item.completed` events update text; `turn.completed` is the successful provider terminal event; `turn.failed` and non-retry `error` events carry failure details. Unknown events remain available in the normalized event stream. In the completed proof, the raw JSONL and normalized provider-event sequences matched exactly and in order, including across Engine B recovery. Host stdout and stderr byte counts matched the committed streams and final ACK/durable offsets.

Failure classification distinguishes authentication, quota, rate limiting, permission, provider availability, context/session loss, malformed provider protocol, unsupported CLI capability and unavailable Custody. No unbounded automatic retry was added. A Codex final answer is not treated as proof that tests passed: the task workspace, process record and test result are checked independently.

## Real Engine A-to-B proof

The completed run used the explicitly selected `gpt-6-luna` model, Codex CLI `0.164.0-alpha.11.1`, Node `v22.20.0`, one published workflow, one Host and one disposable Git project at `C:\my\2026\deszo-codex-custody-workspace-i7v0XC`, outside the Deszo repository and user profile. The Codex executable SHA-256 was `1103e9e09c71fa2cd0afd6d8f3b9a2d63174fe8efd7cb5bd09f1cb14ef58a098`; the Rust Host SHA-256 was `65f0e26ea5840c8ebd78c0ec5dc0a58d2116e135c8861eb2a7ae81bf2171d5ff`. The prompt used `codex exec --json`, `--sandbox workspace-write`, `--ask-for-approval never`, and `--ephemeral`; it did not use an npm shim or stage, commit or push.

The exact timeline is in the JSON evidence. Key UTC observations:

| Time | Observation |
|---|---|
| 2026-10-26 04:21:11.560 | Host PID `26032` started. |
| 2026-10-26 04:21:13.345 | Engine A PID `27428` owned `runner.lock` id `9bf85524-df44-42a2-aec5-42e0c5f78110`; Host epoch 1. |
| 2026-10-26 04:21:14.445 | Run `70280dab-7f0f-46f5-a05b-61f1b2ee2c49` admitted against published version `dab881b0-aa38-4156-aa29-ed51e02c47f7`. |
| 2026-10-26 04:22:15.820 | One real Codex process launched: PID `24432`, Host creation identity `134374621348492020`, Windows creation identity `2026-10-26T04:22:14.8492018Z`; Attempt `4aefdb8e-2448-46d9-b3e1-a439a331e56e`; custody invocation `c74e5723-33b1-4fc7-9846-5793d0b9678e`. Host launch count: 1. |
| 2026-10-26 04:22:25.840 / 04:22:27.446 | The foreground gate (PID `26060`, Windows creation identity `2026-10-26T04:22:25.7775091Z`) wrote READY; the harness observed it while Codex was alive and verified the gate was a Codex descendant. Run and Attempt were still running, workspace hold was held, project files were unchanged, and no terminal event had been emitted. |
| 2026-10-26 04:22:30.627 | Cutover barrier confirmed. Engine A had committed and acknowledged stdout byte offset `630`; Host durable stdout was `630` bytes. Normalized output was `881` bytes. |
| 2026-10-26 04:22:32.561 | Only Engine A was terminated. Host, Codex PID/creation identity and the gate remained alive. |
| 2026-10-26 04:22:35.898 | Engine B PID `16076` acquired a new `runner.lock` id `24d0fd86-e6ba-4083-886d-2915341237bc` and attached to Host epoch 2. |
| 2026-10-26 04:22:37.384 | Engine B reattached the original Attempt and live Codex PID. It retained the exact `630`-byte committed stdout prefix and ACK offset; normalized prefix was retained without duplication. No terminal event existed. |
| 2026-10-26 04:22:37.387 / 04:22:37.488 | The harness wrote RELEASE only after reattachment; the same gate accepted it and exited 0. |
| 2026-10-26 04:23:17.043 / 04:23:17.142 | The original Run succeeded; Host process tree ended with exit code 0 and complete spool; workspace hold was released with `processTreeEnded: true`. |
| 2026-10-26 04:23:20.089 | Independent project verification passed. |

Final raw stdout was `17,111` bytes and stderr `158` bytes; committed, acknowledged and Host-durable offsets matched exactly for both streams. Raw Host spool files are retained under the `custodyStateRoot` named in the machine-readable record. Provider event count and normalized event sequence were compared byte-for-byte at the event-object level; every Codex JSONL event appeared exactly once and in order. There was one committed invocation and one terminal Attempt settlement.

Codex changed exactly `README.md`, `src/normalize.mjs` and `test/normalize.test.mjs`. Its `node --test` command item (`item_9`) completed with exit code 0. Independent `node --test` passed 3/3; `git diff --check` and all three baseline-to-result whitespace checks passed. Codex's final read-only `git status`/`git diff` inspection (`item_10`) returned exit code 1 because Git rejected the disposable directory as dubious ownership under the sandbox identity. No stage, commit or push was attempted; the outer harness independently verified exact changed files, zero staged files and no commit. The project began with zero commits and zero staged files, and ended with zero staged files and no commit.

The earlier 2025-10-25 real task did not reach a barrier and used a broken `npm test` shim; its original non-verifying machine record is preserved at [2026-10-25-codex-custody-real-prior.json](evidence/2026-10-25-codex-custody-real-prior.json). During this task, a 900-second workflow timeout was rejected by the 600-second workflow limit before any Codex launch; a later real task exposed a stale Host-record snapshot in the harness and stopped before Engine A replacement. Both diagnostics are preserved in the linked JSON files above; neither is counted as a passing proof. The stale-snapshot fix now waits for a fresh Host record whose ACK matches the committed bytes before cutover.

The packaged Tauri Proof B and its Process Custody variant remain fixture-based. A real Codex Tauri desktop replacement was not performed and is not inferred from this Node/Host proof.

## Stop and recovery semantics

The Host owned the provider process and Windows Job Object from launch. Engine generations attached through Host epochs; after Engine A termination, Engine B used the persisted Attempt/custody binding and acknowledged the journaled byte prefix without relaunching Codex. Host exit and the completed process tree supplied the workspace-hold release evidence.

## Tests and review

Focused provider/engine/authoring tests passed 47/47. The final full repository `npm test` run passed all 778 tests (769 top-level tests), exit code 0. It included the packaged Tauri Proof B and the Process Custody variant; both passed. The earlier full run had reported 775 passing tests and one failing nested Tauri Custody proof because its deterministic provider fixture did not advertise the required capability flags. The fixture was corrected, and both desktop variants then passed in the final full run. Rust Lifecycle Host tests passed 23/23. These are the frozen candidate's prior regression results; they were not repeated because production code did not change during this proof task. The completed 2026 real-Codex project separately passed Codex-invoked and independent `node --test` runs at 3/3 each. The original 2025 task's npm shim failure and post-exit 3/3 direct Node test are documented in its preserved historical evidence.

`npm run docs:check` passed (31 schemas, zero errors), and `npm run build` passed with a Vite large-chunk warning on the frozen candidate. No production source changed during this real-proof task, so the prior 778/778 Runtime and 23/23 Rust regression evidence is preserved rather than rerun. The isolated proof's 3/3 independent project tests and this harness's `--validate-only` checks are new evidence. The source manifest is regenerated after the final review and checks.

The frozen candidate's changed source, test and documentation files are listed in the [SHA-256 manifest](evidence/2026-10-25-codex-custody-source-manifest.json). The manifest file's own SHA-256 is reported in the delivery summary.

## Remaining limitations

- Real Tauri desktop replacement remains unverified.
- The prior user-level npm shim remains broken; this proof avoided it by verifying and using `node --test` directly.
- Interactive provider approval/input has no Judge-mediated route in this stage. Non-interactive policy is used; unsupported interaction must fail or block rather than create a provider-to-user side channel.
- This is one `codex exec` turn, not a durable multi-turn conversation. No app-server, Judge, Self-Repair, other provider, or UI redesign was added.

Stage 1's real-provider Node/Host continuity criterion is complete. A separately authorized real Codex desktop replacement proof would be needed to extend the claim to the packaged Tauri application.

## Addendum (2026-10-26): F3 terminal settlement review and correction

This addendum does not change the Stage 1 observations above. The raw evidence in `docs/reviews/evidence/2026-10-25-codex-custody-real.json` is preserved unchanged.

**The Stage 1 proof did not violate F3.** The durable record order is: Host record `exited`, `drained: true`, `spoolComplete: true` written at 04:23:16.600 (`attempts/c74e5723-….json`); Engine hold release with `processTreeEnded: true` at 04:23:16.777; attempt `succeeded` at 04:23:16.963 (journal sequence 63); run `succeeded` at 04:23:17.030 (journal sequence 68). The harness observations at 04:23:17.043, 17.050 and 17.142 read the states in that order; they are not the event times. The 99 ms difference is observation order, not an ordering violation. The leader exit time and the moment the Job became empty are not recorded by any artifact.

**Latent defect found and corrected.** `CustodyChild.finish()` gated the tree proof only for the `exited` state. A Host `stopped`, `deadline_terminated` or `emergency_stopped` end with `processTreeEnded: false` and exit code 0 fell through to `code = exitCode`. A scripted-Host run through the real Engine showed the attempt settling `succeeded` in 8 of 11 cases before the fix. The Host reaches the undrained stop-family combination only if the Job is still non-empty after termination. Termination errors are ignored at `custody.rs` (`terminate` calls), so this is reachable only under a termination failure. The workspace hold stayed protected throughout.

**Correction (F3 terminal safety).**
- `runtime/core/custody.mjs`: `finish()` requires `processTreeEnded === true` for every state; an undrained end becomes `tree_not_ended`; a proven stop-family end becomes its stop state; `exited` with `spoolComplete !== true` becomes `spool_incomplete`.
- `runtime/core/engine.mjs` (`settleAgentProcess`): a Host stop is a stop outcome and never a result. `succeeded` requires no outcome signal. An unproven stop-family end is failed with the tree message. A proven stop-family end is canceled (when the Engine requested the Stop), a deadline is a timeout failure, and any other stop is canceled. The exited-undrained early return is unchanged from HEAD.
- Outcome mapping: `stopped` / `emergency_stopped` proven with exit 0 is canceled; `deadline_terminated` proven is a timeout failure; any undrained stop-family end is failed as an unproven tree. Hold release is still gated on `processTreeEnded === true`.

**Error-code correction.** A launch error whose code was outside the journal's `attempt.error` enum made `failAttempt` throw a schema `ContractError`, which was recorded as `process`. `engine.mjs` now maps any raw code outside the 15 codes that both journal schema versions accept to `provider_unavailable`, and keeps the raw code and message as the attempt's evidence.

**Host persistence ordering (launch_failed).** In `custody.rs`, the drain verdict is reverted to not-drained and the Job is kept for `recheck_drain` if the `launch_failed` record cannot be written. A regression for this needs a failure injected into the launch error path, which no existing test hook provides, so it is not covered by a test. A terminal record without a process can still be visible before it is durable; that is a documented limitation.

**Review findings** (first review, seven findings; focused re-review, four findings) are dispositioned in the F3 handoff report and in `docs/reviews/evidence/2026-10-26-f3-terminal-fix-source-manifest.json`.

**Verification.** The frozen light candidate passed the focused F3 suites (43 of 43), the process-custody subset (2 of 2), the Rust lifecycle-host suite (23 of 23), `docs:check` (0 errors), `build` and `git diff --check`. The full `npm test` did not complete on the frozen candidate; see the manifest's `supersededRuns`.

**Verdict:** `F3 FIX NOT VERIFIED`. The focused F3 behaviour is verified; the required full regression has no terminal result. Remaining limitations are listed in the handoff report.
