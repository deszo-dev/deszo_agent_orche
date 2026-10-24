# ADR-0006 executable completion plan

- Date: 2026-10-21 (reconciled against the live host on 2026-10-21 and the continuation-6 checkpoint of 2026-10-20).
- Subject: [ADR-0006](0006-time-bounded-autonomy-and-application-lifecycle.md), criteria ADR6-01 to ADR6-15.
- Companion records: [status](0006-implementation-status.md), [acceptance matrix](0006-acceptance-matrix.md), [route and credential matrix](0006-route-credential-matrix.md).
- Status: **ADR-0006 is not complete.** This plan orders the remaining work and states what each closure requires. It does not change any criterion disposition, which remains in the acceptance matrix.

## 1. Reconciled state (read-only, 2026-10-21)

| Item | Observed |
| --- | --- |
| Branch, HEAD | `codex/adr-0003-0005-completion`, `8efb0ca`. About 65 uncommitted paths. Nothing committed or pushed. |
| Adapter | `runtime/core/adapters.mjs` SHA-256 `D89EBA18CB9EA4012FDAD3A4870BA35507B00D8351930C6553B133437BCC59FD` (unchanged). |
| Service, launcher | `DeszoControlHost` Running (LocalService, dedicated SID). `InteractiveLauncher` Running. Host health answered, `launcherConnected: true`, assurance `bootstrap`. |
| Consent broker | `ConsentBroker` task **Running**. The checkpoint expected a Running-to-Ready transition that did not happen during this session. |
| Policy | Diagnostic policy `fc342689-8bfd-42e1-90a5-35b52f4a9e66` **expired** at `2026-10-21T02:05:23.477Z`. Used: operations 10, restarts 9, all model/provider/workflow/build/repair counters 0. Dispatch not blocked. No active work. |
| Pending native request | `26fb07be-2f07-4d17-8f70-51c601911250` (verify, stop, verify) was **never enqueued**. Nothing to replay. |
| Live Deszo | No `deszo.exe`, no runner process. |
| Sealed builds present | `adr6-handoff-7477f2cd8b927007`, `adr6-native-26e2ad1f6094a77c` (and `-2`, `-3`). All are diagnostic: no independent compilation attestation. |
| Profiles present | `adr6-native-app-verification`, `adr6-native-fork-557c9060`, `adr6-native-fork-fixed-34412a91`. |
| Incident | `9ce1386b-f943-4de7-888f-a3088a68014a` durably **prepared, not registered** (`foreground-incident-request.json`). |
| Open MCP incidents (historical) | `2252a26c…`, `934443ca…`, `76ad07e4…`, `a9aed647…`. Not closed. |

Consequence: no stored or live authority can dispatch lifecycle, provider or feature work now. Any further application action needs a new decision-bound Windows Hello consent, whose exact scope must be prepared first.

## 2. Evidence classes

- **Source**: code exists. Establishes nothing about behavior.
- **Fixture**: deterministic tests with temporary stores and injected components. Establishes engine or host logic.
- **HTTP/IPC integration**: real runtime or host over real HTTP or named-pipe calls, still with a fixture host.
- **Installed mechanism**: the installed service, launcher and Jobs with a fixed diagnostic executable (`scripts/verify-control-host-native.mjs`).
- **Actual application**: the sealed Deszo, its Tauri and Node chain, real owned workflow attempts, real profiles and native UI.
- **End-to-end acceptance**: one authorized same-boot session on the real saved workflow, with independent review and business acceptance.

A criterion closes only with its required classes present for the exact installed source and build.

## 3. Criterion plan

| Criterion | Implemented now | Remaining defect or missing function | Required test | Closure condition | Class needed | Physical action |
| --- | --- | --- | --- | --- | --- | --- |
| ADR6-01 consent | Installed WebAuthn broker, real Hello enrollment, decision-bound diagnostic policy (physically consented). | Synthetic/self-input refusal, cancellation, credential replacement, lost reply on the native path, locked verifier. | Native negatives plus fixture negatives for replacement/lost reply. | All negatives refuse with native evidence; one exact feature-scope decision consented. | Fixture, installed, actual application | Yes: new Hello decision, cancellation, replacement (exact procedure required). |
| ADR6-02 same-boot continuity | Crash, SCM restart and real Node replacement preserve expiry and counters. | Controlling-application replacement under feature authority. | Actual controlling replacement with unchanged expiry/counters. | Controlling replacement under the authorized scope, counters verified. | Actual application, E2E | Yes: consent for that scope. |
| ADR6-03 scoped registration | Native peer, root, build and profile checks; one-use launch proof; Node re-registration. | Stable-root service reattachment; full recovery matrix. | Reattachment after a service crash with the stable root; registration negatives. | Recovery matrix passes natively. | Installed, actual application | No for the matrix; the stable-root case needs the consent that starts it. |
| ADR6-04 time, boot, revoke races | Monotonic/wall minimum, native expiry, session-chain revocation and expiry (superseded work included). | Native sleep, hibernate and reboot; native revoke/admit races. | Revoke/admit race harness on the installed service; sleep/reboot procedure. | Races refuse extension; post-reboot refuses the old policy. | Installed, physical | Yes: sleep/hibernate and reboot. |
| ADR6-05 scope, TCB, routes | Installed ACL and medium-token probes; workspace identity gates provider charges; **route family HTTP negatives (continuation 7, 6/6 pass)**. | Tauri/MCP route negatives; TCB promotion tests; protected-artifact tamper tests natively. | Route tests on the Tauri command path; TCB closure tamper tests. | Every route family has a refusal test per credential; TCB promotion refused on tamper. | Fixture, HTTP, installed | No. |
| ADR6-06 persistent worker | Installed deterministic worker, durable leased queue, ACK checks, incident spool. | Measured transport timing; installed stall and injection tests; real repairs and accounting; chat-inactive continuity. | Installed timing and stall probes; repair workflow run. | Timings measured on the installed profile; continuity shown with chat closed. | Installed, actual application | Partly: needs a live authority. |
| ADR6-07 independent quality gates | Engine review, Context and acceptance logic unchanged; host approval never substitutes. | Real-role independent acceptance evidence. | A saved-workflow run with the required roles. | Acceptance evidence exists for the real feature. | E2E | Needs provider budget authority. |
| ADR6-08 exact replacement | Sealed diagnostic relaunch: native image, profile, generation and foreground capture match. | Source-to-compiler attestation; routine unattended promotion; controlling replacement. | Attestation tests; promotion tests; replacement run. | Attested manifest binds source, build and artifacts; replacement verified. | Installed, actual application | Yes: consent. |
| ADR6-09 fail-stop topology | Eleven installed mechanism scenarios; crash of a real contained Deszo and Node. | Stable controlling Deszo outside the domain with its owned attempts contained; preview-versus-controlling topology. | Real stable-controller run with owned attempts; service crash. | Stable controller and unrelated processes survive; owned attempts stop. | Actual application | Yes: consent to start the topology. |
| ADR6-10 interruption and lost replies | Durable intents and receipts, native pre-resume admission journal, Stop epochs, outbox reconciliation. | Remaining native failure windows; real worker recovery. | Fault injection at each boundary, natively. | Each window reconciles without replay. | Installed, actual application | Partly. |
| ADR6-11 native UI and identity | Native capture binds birth, session, generation, foreground and PNG. | Functional UI; wrong identity/profile/protocol/user/session negatives; locked desktop. | Native negatives; locked-desktop procedure. | Negatives refuse; locked desktop blocks UI acceptance. | Installed, actual application, physical | Yes: lock and unlock. |
| ADR6-12 data-compatible rollback | Native live-profile refusal; stopped-profile fork preserves incident writes and original bytes. | Hot-WAL native crash; migration matrix; compatible executable rollback. | SQLite crash and migration harness on copied profiles; rollback with two real builds. | Restore preserves newer committed data; incompatible restores refuse. | Fixture, actual application | Rollback needs the lifecycle consent. |
| ADR6-13 shared limits | Engine provider charges; host ledger; unknown charges retained. | Repair, build, check and worker charges linked end to end; repeat-failure bound. | Accounting tests across all linked operations. | One ledger, no double count, bounded repeats. | Fixture, installed | No. |
| ADR6-14 independent audit | Host audit chain, native Job evidence, SCM lineage, incident spool. | End-to-end reconstruction of consent, identities, budgets and recovery. | Audit export and verification over a real session. | Qualified export verifies. | E2E | Only through the pilot. |
| ADR6-15 pilot | Nothing end to end. | Full pilot (section 5). | Pilot procedure. | Verified local branch with accepted candidate. | E2E | Yes. |

## 4. Ordered work packages

Each package states whether it is unblocked. Unblocked work proceeds without the user.

1. **WP-1 Route and credential negatives.** Unblocked. HTTP negatives over the host-bound runtime are done (`adr6-route-matrix.test.mjs`, 6/6). The MCP bridge controller-credential negative is done (`adr6-bridge-credentials.test.mjs`, 1/1). Remaining: Tauri command path negatives (the shell registers only `get_runner_connection`) and the packaged-runtime case with no first-party credential.
2. **WP-2 Source-to-compiler attestation.** Unblocked, engineering. Capture commit, dirty-source digest, dependency lock, tool and compiler versions, command lines and artifact digests. Bind them into the manifest. Diagnostic builds stay refused for production lifecycle. Done as fixture: the verifier, the command allowlist and the staging refusal (9/9 and 6/6). Open: the native bounded-command executor that production requires; it is not written.
3. **WP-3 SQLite crash and migration harness.** Unblocked, engineering. Kill a writer during a committed WAL write, reopen, and assert restore refusal or acceptance exactly as specified. Migration matrix over stored profile schema versions. Runs on copies, never on the original profile. Done as fixture: the hot-WAL SIGKILL restore (2/2) and the migration matrix (3/3). The native hot-WAL crash on the installed profile remains.
4. **WP-4 Revoke/admit race harness.** Partly unblocked. A fixture harness first; the installed service variant needs an installed revoke scenario that stops a running Node-side admission.
5. **WP-5 Worker timing and stall harness.** Fixture part unblocked. Installed measurement needs a live authority (WP-7).
6. **WP-6 Stable-controller topology.** Design and native harness can be prepared now. Execution against the real application requires a new consented authority (WP-7).
7. **WP-7 Authority renewal (physical).** Blocked on the user. Prepare the exact scope first: profile `adr6-native-app-verification`, verification-only or feature-development scope, budgets carrying consumed usage, and the explicit operations. Consumed counters are carried forward, never reset.
8. **WP-8 Foreground handoff (physical).** The broker must return to Ready. Procedure: the user closes the ConsentBroker window with its close control, then makes no mouse or keyboard input for twenty seconds. No automated input.
9. **WP-9 Incident registration.** Engineering done: an operator-gated `incidents.spool` route in source, and a filing client, `scripts/file-incident-spool.mjs`. The route is installed only by the protected update. Delivery to the original profile happens at an authorized launch, through the worker's flush for the current policy. No headless start is needed or approved.
10. **WP-10 Physical environment tests.** Sleep or hibernate, lock and unlock, OS reboot. Each has an exact expected refusal, to be observed by the user and recorded by the host.
11. **WP-11 Real pilot.** Blocked on WP-2 to WP-8 and on approval of the revision scope. Requires the saved feature workflow to be validated first. Workflow revision 4 is not approved.

## 5. Pilot prerequisites

The ADR6-15 pilot needs all of the following, with native evidence:

- A current-source attested build (WP-2) and a stable-controller topology (WP-6).
- Fresh Windows Hello consent for an exact feature-development scope (WP-7).
- The saved workflow revision validated before execution. Revision 4 is not approved and is not applied implicitly. Any uncovered revision is prepared as an exact proposal for the required decision.
- Provider and model bindings preserved, with explicit efforts, separate Code Reviewer and Test Reviewer roles, and business acceptance.
- Native functional UI verification and verified local feature-branch delivery binding the accepted candidate, tree, checks and commit.

Preview-only success cannot satisfy controlling replacement. Operational auto-approval cannot supply review, Context compatibility, criterion evidence, business acceptance or READY_FOR_MERGE.

## 6. Human actions to request, in order

Each request is prepared first; nothing is requested without its exact procedure.

1. **Close the ConsentBroker window** and make no mouse or keyboard input for twenty seconds (WP-8). No new consent is needed for this step.
2. **Fresh Windows Hello decision** for the exact scope in WP-7. Decline is a valid outcome and records no authority.
3. **Physical environment checks** (WP-10), one at a time, each with a recorded expected refusal.
4. **Incident 9ce1386b** (WP-9): no decision needed. File it under the extended policy after the protected update, then deliver it at the authorized launch. The steps are in the [acceptance package](../../.deszo/pilots/adr6-completion/ACCEPTANCE-PACKAGE-2026-10-21.md).

No physical action is performed or simulated by automation. No synthetic input, registry change or fixture key stands in for any of them.

## 7. Closure rule

ADR-0006 is complete only when every row in section 3 has the evidence class it requires, for the exact installed source and build, and the pilot in section 5 has run. Until then each criterion keeps its disposition in the acceptance matrix. A failed or partial result is preserved, not replaced.
