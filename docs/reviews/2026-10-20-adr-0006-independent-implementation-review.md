# ADR-0006 independent implementation review

- Date: 2026-10-20
- Branch: `codex/adr-0003-0005-completion`
- Base HEAD: `c60618987150c3514509a9d17ffacf0f0890cc36`; ADR-0006 implementation is uncommitted.
- Subject: [ADR-0006](../adr/0006-time-bounded-autonomy-and-application-lifecycle.md), its [implementation status](../adr/0006-implementation-status.md), new host modules and engine/runner/bundle integration.
- Verdict: **Not ready for unattended use or autonomous continuation of the ADR-0003–0005 pilot.** The implementation is a partial authority/lifecycle core, with reproducible defects inside that core and the separately disclosed Windows enablement gates still open.

This review changes no implementation, workflow, role/model/effort assignment or existing historical review. It uses temporary fixture credentials/stores, real local fixture CLI children, and injected lifecycle observers. It installs no service/task, changes no ACL, enrolls no real authenticator and invokes no real model. Source hashes and observed counterexamples are in the [probe evidence](evidence/2026-10-20-adr-0006-independent-probes.json); the [runner](evidence/2026-10-20-adr-0006-independent-probes.mjs) is retained for reproduction. These are independent negative probes, not nine passing safety tests: all nine stated invariants were violated, with zero harness errors.

## Findings

### ADR6-I01 — P1: an active run disappears from the policy's Stop scope

[`createRunUnderHostPermit`](../../runtime/core/hostAutonomy.mjs#L64) settles a permit as consumed immediately after run creation, before its agents finish. [`revoke`](../../runtime/host/authority.mjs#L468) selects only permits whose state is `admitted` for Stop. The running workflow therefore remains in `hostPermitRuns` but its permit is no longer selected or broadcast to it. In N02 a slow real fixture agent was running, the permit was already `settled`, revocation committed with `stopScope: []`, and the run subsequently **succeeded**.

Expiry has the corresponding coverage gap: [`enforcementDeadlineMs`](../../runtime/core/hostAutonomy.mjs#L38) is retained on an admission object but never applied to run dispatch or a supervisor deadline. N08 advanced the manual host clock beyond expiry during a slow fixture run: host status was `expired`, while the run succeeded. This is a logical-clock counterexample, not a claim of a completed native sixty-second expiry test. The absent native expiry/Job enforcement is already disclosed; the early settlement/Stop lookup mismatch also breaks the runtime-mediated revocation path that is claimed implemented today.

Keep budget settlement separate from durable active-work ownership; include all active/pending owned work in revoke/expiry Stop regardless of accounting state. Bind and enforce the remaining lifetime before dispatch and preserve the mapping across recovery. Native enforcement remains mandatory before enabling autonomy. Covers ADR6-04/09/13.

### ADR6-I02 — P1: `runtime.attach` authenticates using identifiers alone

[`runtime.attach`](../../runtime/host/ipc.mjs#L45) accepts a policy ID plus a registered generation and marks the new socket as that runtime. It checks no nonce, connection proof or OS process identity. [`requireParty`](../../runtime/host/ipc.mjs#L62) subsequently checks only the policy ID for permit operations, without matching the permit's generation to the socket's generation.

N01 opened an unauthenticated second pipe connection, supplied the existing IDs, then successfully admitted a run permit. It supplied neither a controller signature nor process evidence. This is an application protocol defect in addition to the documented missing Windows pipe DACL/peer checks; a same-user pipe permission alone cannot establish the intended process identity. Require an independently verified, scoped connection proof and validate its live policy/generation on every privileged message. Covers ADR6-03/05.

### ADR6-I03 — P1: the `status` CLI performs recovery against a live host

[`main`](../../runtime/host/main.mjs#L29) constructs a new `ControlHost` for every command, including `status` and `revoke`. The constructor unconditionally runs [`recover`](../../runtime/host/authority.mjs#L532) with a new host instance. There is no exclusive authority-owner check before it treats other instances' permits and all in-progress operations as interrupted.

N03 kept an original host open with an issued permit and an admitted build operation, then ran the real `status` CLI in another process against the same temporary store. Status invalidated the issued permit, settled the admitted permit as `unknown`, and changed the operation to `reconciling`. The original host's in-memory `dispatchBlocked` stayed null and it still approved another model-call decision. An observational command both changes authority state and leaves the two hosts disagreeing about whether dispatch is blocked.

Route status/revocation through the authoritative service. Offline diagnostics must be explicitly read-only; recovery requires exclusive verified ownership and reconciliation. The `revoke` CLI must reach the live owner that can actually stop processes. Covers ADR6-03/10/14.

### ADR6-I04 — P1: lifecycle approval does not bind the target scope

[`ApplicationLifecycle.restart`](../../runtime/host/lifecycle.mjs#L68) asks the host to approve only `app.restart`, request/policy IDs, cost and rationale. The actual build directory/manifest, profile, application mode, desktop and target process are not part of the decision request. Neither this method nor `evaluate` validates them against the policy's captured scope before Stop or launch.

N04 used a policy for `authorized-profile`, a specific build root and `separate_preview`, then requested `UNAUTHORIZED-PROFILE`, a build outside that root and termination of the fixture's existing controller process. The module stopped it, launched the requested target and returned `verified`. Manifest consistency proves the selected bytes, not authority to select them.

Bind all lifecycle targets to the durable host decision and check them independently before any external effect. Verify ownership of the target being stopped, as well as the one being started. Native peer/desktop checks remain separate gates. Covers ADR6-05/08/11.

### ADR6-I05 — P1: provider budgets count run approvals, not actual invocations

The [`run.approve` minimum](../../runtime/host/authority.mjs#L29) charges one provider invocation, and [`decide`](../../runtime/host/authority.mjs#L325) trusts any larger caller-declared amount. Engine agent/task dispatch does not reserve additional host budget for each actual invocation, retry or context continuation. Its existing task-local limits do not enforce the new session-wide host limit.

N06 ran the existing three-agent context-chain fixture under a policy with `providerInvocations: 1` and a default-cost permit. All **three** agent invocations succeeded; host accounting remained **one**. Reserve/admit/settle authoritative charges at the actual invocation boundaries, including role retries and context retrieval, sharing the ledger with lifecycle/worker costs. Covers ADR6-06/13.

### ADR6-I06 — P1: ambiguous lifecycle exceptions allow another launch

The awaited calls to the launcher, inspector, health checker and UI checker have no enclosing failure/reconciliation transition. For example, an exception from [`launcher.start`](../../runtime/host/lifecycle.mjs#L100) leaves the operation `in_progress` and the permit admitted. The host blocks dispatch only when it later restarts and runs recovery; it does not block a fresh restart request immediately after an ambiguous launch failure.

N09 injected a launcher that records a simulated process-creation effect and then throws a lost-reply error. A new request repeated the effect: two launch effects, two `in_progress` operations at `build_verified`, and `dispatchBlocked: null`. This probe injects the external effect; it does not claim two native Deszo launches.

Bound the external phase calls, persist unknown outcomes as reconciling, and fence conflicting lifecycle requests before returning an ambiguous error. Require independent process/intent reconciliation before any retry. Covers ADR6-08/10.

### ADR6-I07 — P2: the purported one-time registration nonce is replayable

[`registerRuntime`](../../runtime/host/authority.mjs#L269) compares the launch nonce's hash but never consumes it or reconciles a replay to the original registration. It also accepts an operation that has already finished. Each accepted replay allocates a new generation and deletes the policy's previous registrations.

N05 replayed exactly the same proof after lifecycle outcome `verified`. It received a different generation and removed the original live generation. Consume the proof atomically and either refuse replay or return its original receipt without changing runtime identity. Registration must also honor policy validity, expected lifecycle phase and host generation. Covers ADR6-03/10.

### ADR6-I08 — P2: exact create-run retries cannot recover their saved receipt

[`createRunUnderHostPermit`](../../runtime/core/hostAutonomy.mjs#L55) tries to admit the permit before reaching `createRun`'s durable request-ID receipt. After the first successful request, its permit is settled, so an identical retry gets `403 host_refused: permit_settled` before the existing idempotency path can return the committed run.

N07 sent the identical body twice: the first returned 202/created; the second returned 403 although its run receipt existed. Reconcile an exact request to its persisted result without a fresh admission or charge, while refusing a different payload, permit or caller scope. This does not require allowing reuse to create another run. Covers ADR6-10/14.

## Completion and continuation gates

The [implementation status](../adr/0006-implementation-status.md#gates-that-remain-before-any-autonomous-use) correctly discloses missing protected LocalService/service-SID installation and ACLs, authenticated native IPC, trusted consent broker/display, protected interactive launcher, service-owned fail-stop Jobs, immutable build-to-launch identity, the ADR-0001 route/credential reconciliation, persistent restricted worker, compatible rollback and the real replacement pilot. These are acceptance requirements, not optional polish. Source changes contain none of the Windows service/task/consent UI that could provide the requested twelve-hour unattended mode. An environment-bound host adapter is not evidence those gates passed.

The ADR's Stage 1 itself includes the protected Windows authority mechanisms. Calling the implemented subset an authority core is reasonable; calling **Stage 1 or ADR-0006 complete is not**. No ADR6-01–15 criterion is established in full by these fixtures. Documentation that says autonomy stays disabled must be backed by an explicit verified-capability gate before any production use of the new host routes.

| Work | Readiness after this review |
| --- | --- |
| ADR-0003–0005 source work, deterministic fixtures, workflow preparation and audits | Can continue in the current branch. ADR-0006 is not a prerequisite for offline/manual development. This is not acceptance of their remaining real-provider evaluation. |
| A manually supervised live pilot under existing ADR-0002 | Conditional on a running, identified build, verified native/client support, fresh exact grants/session and unchanged saved role bindings. Current MCP is unavailable, so this review has not established those conditions. |
| Twelve-hour autoapproval, unattended rebuild/restart, persistent controller and autonomous ADR-0003–0005 continuation | **Blocked** by I01–I08 plus the documented Windows/worker/recovery gates. No pilot or approval was started by this review. |
| ADR-0003–0005 complete / verified feature branch from real execution | Not established by passing fixtures. Requires the actual accepted candidate, checks, native UI evidence, delivery/commit identity and final audit. |

The next useful implementation milestone is fixing the authority-core findings, then completing and independently testing the Windows authority/launcher/Job path. Only after its enablement gates pass should the pilot be used to prove automatic continuation across replacement of the controlling Deszo. Preserve the baseline-first experiment order and existing model/effort bindings; the large comparative corpus is a separate quota decision.

## Verification

- `docs:check`: passed after adding this review; 29 schemas, 91 Markdown files, 922 local links, zero errors.
- `runtime:bundle`: passed; generated `dist-runtime/host.mjs` and host migration alongside the runtime.
- `build`: passed (`tsc -b` and Vite); Vite reported its ordinary large-chunk warning.
- `npm test`: **480 passed, 0 failed**, no skipped/cancelled tests; serial runtime suite exited 0 in 492,792 ms. This includes the existing ADR-0003–0005 integration/delivery fixtures and the ADR-0006 tests/explorer. Those tests do not cover the counterexamples above.
- Independent probes: **9 violated invariants / 9 probes**, zero harness errors, runner exit 1 intentionally denotes reproduced defects. The JSON binds evidence to source SHA-256 hashes and base HEAD. These results must not be represented as nine passing acceptance tests.
- MCP `get_authoring_contract`: `503 runtime_unavailable`. No live runtime identity, native application switch or installed supervision acceptance was verified.
- The pre-existing `runtime/core/adapters.mjs` edit is unchanged: SHA-256 `D89EBA18CB9EA4012FDAD3A4870BA35507B00D8351930C6553B133437BCC59FD`.

Reproduction uses no service install or provider quota:

```sh
node --disable-warning=ExperimentalWarning docs/reviews/evidence/2026-10-20-adr-0006-independent-probes.mjs
```
