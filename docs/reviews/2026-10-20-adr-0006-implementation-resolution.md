# ADR-0006 independent-review resolution (ADR6-I01 to ADR6-I08)

- Date: 2026-10-20
- Branch: `codex/adr-0003-0005-completion` (local; not pushed or merged)
- Subject: [ADR-0006](../adr/0006-time-bounded-autonomy-and-application-lifecycle.md) and the [independent implementation review](2026-10-20-adr-0006-independent-implementation-review.md)
- Status: all eight findings are fixed in code and each has a regression test that replays its counterexample. The review, its probe runner and its recorded evidence are unchanged. This record does not claim the ADR complete; see the [acceptance matrix](../adr/0006-acceptance-matrix.md).

## Scope and history

The review's probes (N01–N09) recorded the defects against source hashes at base `c606189`. This record first verified that those source hashes still matched the working tree, so every finding was current when the fixes began. The original probe runner was **not** re-run, because it overwrites its recorded evidence file. Its counterexamples are replayed, with the same names and invariants, by [`adr6-regressions.test.mjs`](../../runtime/tests/adr6-regressions.test.mjs). Historical reviews, the probe runner, the probe JSON and the pre-existing adapter change are untouched.

Fixture-level results only. These tests use temporary stores, injected launcher/inspector/health components and fixture-assurance hosts. Windows enforcement is covered only where the separate native tests say so (see the matrix).

## Dispositions

| Finding | Original counterexample | Changed contract and implementation | Regression tests (replayed counterexample) | Remaining verification |
| --- | --- | --- | --- | --- |
| ADR6-I01 settlement vs ownership; expiry | N02: permit settled, run still active, revoke `stopScope: []`, run succeeded. N08: expiry during a slow run, run succeeded. | Permits settled as consumed now record **owned work** in a durable `active_work` table ([`host-h2.sql`](../../docs/storage/host-h2.sql)). Revocation and the new `enforceExpiry()` report every owned work item and admitted permit as the Stop scope, regardless of accounting state. Owned work survives a host restart and blocks dispatch until native reconciliation. The runtime arms its own timer for the authorized remainder and reports the terminal state of owned runs. Stop messages carry run references. | `ADR6-I01 (N02)`, `ADR6-I01 (N08)`, `ADR6-I01: owned work survives a host restart` | Native enforcement of the expiry deadline (a service-owned timer and Job) is not verified. |
| ADR6-I02 identifier-only authentication | N01: an unauthenticated peer with policy and generation IDs attached and admitted a permit. | Attach requires the **attach secret** issued at registration; only its digest is stored; comparison is constant time. Launched runtimes redeem a **host-generated** one-time proof (I07). Permit operations require the live generation the permit names, under a valid policy. Runtime connections may request only `provider.invoke`, and only for their own generation. An optional peer verifier can add OS identity; without one the registration matches only host-observed process evidence (fixture assurance). | `ADR6-I02 (N01)`, `attach secret ... re-binds`, `runtime connection may request provider charges only for its own live generation` | Named-pipe DACL, `FIRST_PIPE_INSTANCE`, and client PID/token/session verification are not implemented. Node exposes no peer PID; a native helper is required. Production assurance refuses to start until this is verified. |
| ADR6-I03 status is not observational | N03: the `status` CLI recovered a live host's store, invalidated its permit and changed its operation to reconciling. | `status` and `revoke` are separate: `status` asks the live owner over IPC and otherwise opens the store **read-only** (no recovery, migration, lock or write). `revoke` requires the live owner, because only the owner can stop processes, and authenticates with the installation's user-surface secret. `serve` takes an exclusive owner lock (`host-owner.json`) before recovery, and a second owner is refused. | `ADR6-I03 (N03)`, `second authority owner ... refused`, `revoke from the command line refuses` | Pipe-level single-owner enforcement by the service and an installation-protected owner lock are gates. The lock file is only as protected as its directory. |
| ADR6-I04 lifecycle target not bound | N04: an unauthorized profile, a build outside the root, another mode, and termination of an unowned process were all accepted and the launch verified. | The `app.*` decision request now carries a **target** (profile, application mode, desktop/session, build root, build directory, build ID, and the process to stop). Evaluation refuses each mismatch before any external effect. A process may be stopped only if the host started or registered it for the policy. The inspector's session must match the authorized desktop. | `ADR6-I04 (N04)`: five refusal cases, each asserting that nothing was stopped or launched | Native session/desktop and process-ownership checks are fixtures; the native inspector is not built. |
| ADR6-I05 budgets count approvals, not invocations | N06: three real agent invocations under `providerInvocations: 1`; charged 1. | A run creation now charges one **attempt** only. Each provider (agent CLI) invocation, including retries and context continuation, is a separate `provider.invoke` decision, admission and settlement by the host, charged at the engine's single process-launch boundary ([`engine.mjs`](../../runtime/core/engine.mjs), `reserveHostProviderInvocation`). A refused invocation fails the attempt as `host_refused` before any CLI starts. Worker model calls have their own key but no worker exists yet. | `ADR6-I05 (N06)`: at most one invocation completes and at most one is charged | Worker model calls are not charged anywhere (the worker is not built). Preview and native runs are not measured. |
| ADR6-I06 ambiguous lifecycle exceptions | N09: a launch whose reply was lost was repeated: two effects, two operations, nothing blocked. | Every external lifecycle call is bounded by a phase timeout. An exception or timeout after an operation began is persisted as **reconciling** (not a clean refusal), the permit is settled as `unknown`, and dispatch is blocked until reconciliation with evidence. A stop that completes while the process lives is an established `blocked`. Launch proofs are issued only after a verified build and only one launch can be requested. | `ADR6-I06 (N09)`, `stop call that never answers is bounded` | Lost replies from the real launcher and inspector are not exercised. |
| ADR6-I07 replayable registration nonce | N05: replaying the same proof after `verified` allocated a new generation and removed the live one. | The launch proof is **host-generated**, stored as a digest, and consumed in the same transaction that allocates the generation. Registration also requires the live policy, the `launched` operation phase, the host instance and the expected process (and peer, when given). A replay is refused with `proof_consumed` and changes nothing. | `ADR6-I07 (N05)`, `peer that is not the observed process is refused` | None beyond the peer-verifier gate in I02. |
| ADR6-I08 exact retry blocked | N07: an identical create-run retry returned 403 `permit_settled`, although its receipt existed. | Before admission, an exact replay of a committed `command_receipts` row returns the stored response, with no admission and no charge. A different payload or a different caller scope (command) is refused with 409, as the engine's idempotency rule already did. | `ADR6-I08 (N07)`: same run, no charge, different payload and other caller refused | None. |

## Additional gap closed during implementation (route guard)

While implementing I05 and I08, the engine was found to create runs on three routes that did not pass a host permit: a first-party direct create, the approval of a pending external request, and chat turns. Provider invocations on those runs were still charged, but no host run decision was made, which ADR-0006 forbids. In a host-bound runtime these routes now refuse with `host_permit_required`. Pending confirmation requests still create nothing. Test: `ADR6 route guard` in `adr6-regressions.test.mjs`. The route/credential matrix (gate `routeCredentialMatrix`) remains unpublished, so production autonomy stays disabled.

## Enablement gates (ADR6 section 7)

- [`capabilities.mjs`](../../runtime/host/capabilities.mjs) lists ten production capabilities. None is recorded as verified, so a `production` host refuses to start (`autonomy_disabled`). `serve` is production by default.
- Each store records its assurance level. A fixture store cannot be opened at production assurance, and a production store cannot be opened as fixture (`assurance_mismatch`).
- A runtime refuses a fixture-assurance host unless `DESZO_ALLOW_FIXTURE_HOST=1` is set and it is not the packaged application.

Tests: `Enablement: ...` in `adr6-regressions.test.mjs`.

## Native checks run on this Windows machine

[`jobguard.cs`](../../runtime/host/native/jobguard.cs) is a prototype of the service-owned fail-stop Job. It creates a kill-on-close Job, creates the child suspended, assigns it before it runs, reports the kernel handle count of the Job, and refuses to trust admission when that count is not one. [`adr6-native-job.test.mjs`](../../runtime/tests/adr6-native-job.test.mjs) runs it with real processes:

- a holder crash ends the owned child and grandchild and leaves an unrelated stable process alive;
- a crash between suspended creation and resume leaves no workload, and the child never ran;
- an outside duplicate of the Job handle is detected (count 2) and keeps the tree alive after the holder dies, which shows why admission must refuse it;
- a controller stop ends the whole owned tree.

This is containment mechanism evidence only. It is not the protected service, the SCM, a Scheduled Task launcher, the ACLs, or Deszo's own Job topology.

## Falsification

Each protection was disabled alone in the working tree, the matching regression test was run, and the original file was restored with its SHA-256 verified. Every disabled protection made its test fail:

| Finding | Disabled protection | Test that failed |
| --- | --- | --- |
| ADR6-I01 | Owned work left out of the Stop scope | `ADR6-I01 (N02)` |
| ADR6-I02 | Attach-secret comparison | `ADR6-I02 (N01)` |
| ADR6-I05 | Provider-invocation admission before each CLI launch | `ADR6-I05 (N06)` |
| ADR6-I07 | One-time proof check and atomic claim | `ADR6-I07 (N05)` |
| ADR6-I08 | Exact create-run replay | `ADR6-I08 (N07)` |

I03, I04 and I06 are covered by assertions that replay their counterexamples (`N03`, `N04`, `N09`) but were not separately falsified.

## Suite results

- `npm test` (the runtime suite, before the native test file existed): 498 of 498 passing, 0 failing, 0 skipped, exit 0. The 498 are the 480 baseline tests plus the 18 regression tests.
- Native suite run alone: [`adr6-native-job.test.mjs`](../../runtime/tests/adr6-native-job.test.mjs), 4 of 4 passing. It skips where the .NET Framework compiler is absent.
- `npm run docs:check`: passes, no errors.
- `npm run runtime:bundle`: passes; produces `host.mjs`, `host-h1.sql` and `host-h2.sql`.
- The pre-existing `runtime/core/adapters.mjs` change still has SHA-256 `D89EBA18…CC59FD`, as recorded by the review.

## Fixture changes (documented separately, assertions unchanged)

Existing tests were updated only where the contract's input shape changed. No assertion was weakened.

- `control-host.test.mjs` lifecycle tests: the restart call names the target (`applicationMode`, `desktop`, `buildRoot`); the scope's build root is the temporary directory; the controlling runtime is adopted with `registerInitialRuntime` before a switch, because only processes the host governs may be stopped; the fake native inspector reports the desktop session. The launch-start expectations remain.
- `host-autonomy.test.mjs`: the initial runtime attaches with its attach secret (`DESZO_HOST_ATTACH_SECRET`); the policy scope adds `provider.invoke`; the test sets `DESZO_ALLOW_FIXTURE_HOST=1`.

## Remaining (not claimed)

The ADR remains **Proposed**. The protected service, the pipe security descriptor and peer verification, the Task Scheduler launcher, the consent broker with Windows Hello/WebAuthn, the persistent controller worker, rollback and restore, native UI evidence, the ADR-0001 route/credential matrix and the real pilot are not implemented or verified. The [acceptance matrix](../adr/0006-acceptance-matrix.md) records each criterion.
