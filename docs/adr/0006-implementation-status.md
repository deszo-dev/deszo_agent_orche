# ADR-0006 implementation status

- Date: 2026-10-20
- Subject: [ADR-0006](0006-time-bounded-autonomy-and-application-lifecycle.md)
- Status: The eight independent-review findings (ADR6-I01 to ADR6-I08) are fixed in code with regression tests ([resolution](../reviews/2026-10-20-adr-0006-implementation-resolution.md)). Native containment is prototyped and tested on Windows for the Job mechanism. Production autonomy stays **disabled** by code: no enablement capability is verified. The ADR remains Proposed. Criteria are tracked in the [acceptance matrix](0006-acceptance-matrix.md); none is satisfied.

## Implementation context

On 2026-10-20 the user asked to implement ADR-0006 in the current `codex/adr-0003-0005-completion` branch and to complete it, including a pilot. This work authorizes code in the branch and fixture and native tests on this machine. It does not install the protected service or a Scheduled Task, change ACLs in the protected locations, enroll a real authenticator, start an autonomous session, invoke a provider for the pilot, or push, merge or release. The pre-existing uncommitted change to `runtime/core/adapters.mjs` was left untouched.

## What is implemented

| Area | Implementation | Verified by |
| --- | --- | --- |
| Contracts | [`autonomy-policy.schema.json`](../schemas/autonomy-policy.schema.json): proposed decision, consent assertion, decision request with lifecycle `target`, decision receipt, build manifest, operation outcomes; `provider.invoke` operation. `createRun.hostPermitId` in [runtime-api-v2](../schemas/runtime-api-v2.schema.json). | `docs:check`; contract checks inside every host call |
| Host store | [`host-h1.sql`](../storage/host-h1.sql) and [`host-h2.sql`](../storage/host-h2.sql): a separate database owned by the host (credentials, challenges, policies, ledger, decisions, permits, operations, owned work, registration proofs, hash-chained audit, assurance marker). Not part of the application store, so an application-data restore cannot touch it. | `control-host.test.mjs`, `adr6-regressions.test.mjs` |
| Trusted consent | [`authority.mjs`](../../runtime/host/authority.mjs) `proposePolicy` / `authorizePolicy`: the host builds the exact decision, issues a 5-minute single-use challenge bound to its digest and audience, and accepts an Ed25519 signature from an installation-enrolled credential over the challenge data and user-verification flags. Lost replies reconcile to the committed receipt. | ADR6-01 fixture tests |
| Time | [`timeSource.mjs`](../../runtime/host/timeSource.mjs): Windows `BootId` plus `GetTickCount64` uptime (counts sleep and hibernation); authority is the minimum of monotonic and wall remainders; a different or unreadable boot blocks the old policy. | ADR6-04 fixture tests |
| Decisions and budgets | `decide` in one `BEGIN IMMEDIATE` transaction checks controller or runtime party, revocation, expiry, barrier, reconciliation state, operation, workspace, workflow revision, command, lifecycle target, owned process and shared ledger, then records the receipt, permit and reservation. Runs charge one attempt; each provider invocation charges one `providerInvocations`. | ADR6-01, 05, 13 tests; N06 |
| Admission and revocation | `admit` is the ordering point. `revoke` closes the barrier, commits the generation change, invalidates unadmitted permits and returns the Stop scope: admitted permits and owned work. `enforceExpiry()` closes an expired policy once, with the same scope. | ADR6-04, N02, N08 tests |
| Owned work | Permits settled as consumed record their run as owned work (`active_work`). The owned work stays in the Stop scope until the runtime reports it terminal, whatever the permit's accounting state. | N02, N08, owned-work restart test |
| Recovery | On every start: audit-chain check; unadmitted permits of the previous instance invalidated; admitted ones settled `unknown` and kept charged; in-progress operations become `reconciling`; owned work of the previous instance blocks dispatch until native reconciliation; launch proofs of the previous instance cannot register. | ADR6-02/03/10 tests |
| Owner and read-only view | `serve` takes an exclusive owner lock before recovery; a second owner is refused. `status` asks the live owner or opens the store read-only and changes nothing. `revoke` reaches the live owner with the installation's user-surface secret or refuses. | N03 and owner tests |
| Assurance and gates | [`capabilities.mjs`](../../runtime/host/capabilities.mjs): ten production capabilities, none verified. A production host refuses to start; a store records its assurance and refuses to open at another level. A fixture-assurance host is refused by the runtime unless `DESZO_ALLOW_FIXTURE_HOST=1` and not packaged. | Enablement tests |
| Lifecycle | [`lifecycle.mjs`](../../runtime/host/lifecycle.mjs): manifest verification, target authorization before any stop, bounded external calls, host-generated launch proof bound to the observed process, registration, health, optional UI evidence. Ambiguous outcomes are `reconciling`; established outcomes are `blocked`, `failed` or `verified`. | ADR6-08/11 tests; N04, N09 |
| Runtime binding | [`runtimeBinding.mjs`](../../runtime/host/runtimeBinding.mjs): reads and removes the bootstrap environment (including the proof and attach secret); launched runtimes redeem their proof; the controlling runtime re-attaches with generation and attach secret. | host-autonomy end-to-end test |
| IPC | [`ipc.mjs`](../../runtime/host/ipc.mjs): newline JSON over a named pipe. Controller and runtime authority are bound to the authenticated socket and checked against live state on every privileged message. An optional peer verifier hook supplies OS identity; none is installed. | N01 and IPC tests |
| Engine integration | [`hostAutonomy.mjs`](../../runtime/core/hostAutonomy.mjs) and [`engine.mjs`](../../runtime/core/engine.mjs): permit admission for `POST /api/v2/runs` and supervision grants; exact create-run retry replay (I08); owned-run release on terminal state; deadline timer per run; provider invocation admission and settlement at the single process-launch boundary. In a host-bound runtime every run-creation route needs a permit: direct, chat and approval of a pending request are refused (`host_permit_required`); a pending confirmation request still creates no run. | host-autonomy end-to-end test; N06, N07; route-guard test |
| Native containment prototype | [`jobguard.cs`](../../runtime/host/native/jobguard.cs): kill-on-close Job, suspended creation, assignment before resume, kernel handle count check, controlled stop. Compiled with the .NET Framework compiler; not part of the bundle. | [`adr6-native-job.test.mjs`](../../runtime/tests/adr6-native-job.test.mjs): 4 native tests passing on this machine |
| Entry point | [`main.mjs`](../../runtime/host/main.mjs), bundled as `dist-runtime/host.mjs` with `host-h1.sql` and `host-h2.sql`: `serve`, `enroll` (explicit assurance), and `status` and `revoke` on the user surface. | `runtime:bundle`; CLI tests |

## Gates that remain before any autonomous use

Every gate is recorded in [`capabilities.mjs`](../../runtime/host/capabilities.mjs) and stays unverified until independent evidence exists.

| Gate | Current behavior | Required evidence |
| --- | --- | --- |
| `protectedService` | The host runs as an ordinary process; nothing is installed. The store is only as protected as the directory the caller chooses. | LocalService under SCM with a dedicated service SID; explicit DACLs on binary, state and pipe; tamper tests by the candidate user. Installation needs an administrator. |
| `peerIdentity` | Node pipes use the default DACL and do not expose the client PID or token. Authority is bound to sockets and proofs, not to verified OS peers. | Pipe security descriptor and first-instance creation; native client process, token and session verification; spoofed-endpoint tests. |
| `consentBroker` | Only the signature protocol exists; no Windows Hello/WebAuthn broker or protected display. | Broker identity, protected display of the exact decision, synthetic-input resistance, enrollment and replacement, cancellation and locked-desktop tests. Needs a physical authenticator. |
| `launcherTask` | Lifecycle uses an injected launcher; no Task Scheduler task exists. | Protected task definition and executable; authenticated service connection; bounded commands; tamper tests. |
| `nativeJobFailStop` | The Job mechanism is prototyped and tested natively; the host does not own a Job for Deszo's runs. | Service-owned outer kill-on-close Jobs wired to real launches; Deszo's per-run and application Job topology; service-crash termination of exactly owned work with a stable preview controller surviving; PID-reuse identity. |
| `immutableBuildIdentity` | The launched image is re-hashed after creation; other build files can change until use. | A write-protected build directory or equivalent, tested under the chosen trust profile. |
| `routeCredentialMatrix` | Run creation is host-gated on every route in a host-bound runtime. The first-party token and the runtime's settings, recovery and Context routes are not yet reconciled into a published matrix. | A published ADR-0001 route/credential matrix; no settings, direct-run, recovery or approval route bypasses host limits. |
| `persistentWorker` | Not implemented beyond host accounting of `worker.model_call`. | Restricted worker tool profile, durable queue, processed-observation acknowledgements, injection tests. |
| `compatibleRollback` | `app.rollback` is an authorized operation kind only. | A profile-specific compatible restore plan that preserves newer writes. |
| `nativeUiEvidence` | No UI evidence collection. | Native desktop evidence bound to the OS-observed process and runtime generation; locked-desktop tests. |

## Verification status

- Fixture: `control-host.test.mjs` (13 tests), `control-host-exploration.test.mjs` (1,296 sequences), `host-autonomy.test.mjs` (end to end through the runner), `adr6-regressions.test.mjs` (19 tests replaying N01–N09, the route guard and the enablement gates).
- Native (Windows, this machine): `adr6-native-job.test.mjs` (4 tests) on real Job objects and processes.
- Documentation and bundle: `docs:check` passes; `runtime:bundle` produces `host.mjs`, `host-h1.sql` and `host-h2.sql`.
- Full runtime suite: see the completion note in the [resolution record](../reviews/2026-10-20-adr-0006-implementation-resolution.md).

No Windows service, Scheduled Task, Hello/WebAuthn, synthetic-input, reboot, real sleep, locked-desktop, provider-backed, or controller-replacement test has been performed, and no pilot has run. Fixture tests verify host logic with injected components. The independent review's probe runner and its recorded evidence were not re-run, because the runner overwrites its evidence file; its counterexamples are replayed by the regression tests instead.
