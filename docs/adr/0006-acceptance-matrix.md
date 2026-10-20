# ADR-0006 acceptance matrix

- Date: 2026-10-20
- Subject: [ADR-0006](0006-time-bounded-autonomy-and-application-lifecycle.md) criteria ADR6-01 to ADR6-15
- Branch: `codex/adr-0003-0005-completion` (local)
- Result: **no criterion is satisfied.** Fixture evidence exists for several, and native containment evidence exists for one mechanism. The real pilot (ADR6-15) has not run.

## How to read the evidence

- **Fixture**: deterministic tests in `runtime/tests/` with temporary stores, injected launcher/inspector/health components and fixture-assurance hosts. They verify the host's logic, not Windows enforcement.
- **Native**: Windows evidence obtained outside the candidate, on this machine, with real kernel objects and processes. Only [`adr6-native-job.test.mjs`](../../runtime/tests/adr6-native-job.test.mjs) is native.
- **Pilot**: an authorized end-to-end session on a real Deszo runtime. None has run.

A criterion counts as satisfied only when its fixture, native and (where required) pilot evidence all exist. Documentation checks (`docs:check`) and passing unit tests do not satisfy any criterion.

## Matrix

| Criterion | Implementation | Failure tests (fixture unless noted) | Actual evidence | Status |
| --- | --- | --- | --- | --- |
| ADR6-01 consent exact to the policy; eligible approvals without repeated consent | `authority.mjs` `proposePolicy`/`authorizePolicy`: decision-bound, single-use, expiring challenge; Ed25519 credential enrolled by the installation; `decide` for eligible operations | `control-host.test.mjs` ADR6-01 (self-made key, forged signature, missing user verification, substituted decision, expired challenge, untrusted enrollment, replay); `host-autonomy.test.mjs` (run admitted without the confirmation pause, only that run) | Fixture only. No Windows Hello/WebAuthn broker, no protected display, no synthetic-input test | Not satisfied: consent broker unbuilt (gate `consentBroker`) |
| ADR6-02 same-boot restart keeps expiry, counters and approval | `timeSource.mjs` boot identity and monotonic deadline; restart re-reads the store; `recover()` | `control-host.test.mjs` ADR6-02/03 (restart keeps expiry and counters, invalidates connections) | Fixture only. No service restart, no rebuilt application | Not satisfied |
| ADR6-03 registration and reconnection require fresh authenticated scoped connections | Launch proof (host-generated, consumed atomically); attach secret; party check on generation and live policy; `peerEvidence` hook | `adr6-regressions` N01 (stranger), attach-secret, N05 (proof replay), peer mismatch, generation mismatch; `control-host.test.mjs` ADR6-03 | Fixture only. Named-pipe DACL and client PID/token/session verification are **not** implemented (gate `peerIdentity`) | Not satisfied |
| ADR6-04 sleep, clock, boot and revoke races never extend authority | `remainingAuthority` takes the minimum of monotonic and wall remainders; reboot blocks; revocation barrier and generation; `enforceExpiry()` | `control-host.test.mjs` ADR6-04 (sleep, clock rollback, reboot block, post-reboot linked decision, revocation fence); `control-host-exploration.test.mjs` (1,296 sequences: depth 4, one policy) | Fixture only. No real sleep, hibernation or reboot test | Not satisfied |
| ADR6-05 scope, TCB and protected installation | Scope checks on workspace, workflow revision, command, operation and lifecycle target (profile, mode, desktop, build root, owned process) | `adr6-regressions` N04 (five refusals with nothing stopped or launched); `control-host.test.mjs` ADR6-05 scope refusals | Fixture only. TCB closure, promotion policy and protected service/launcher ACLs are **not** implemented | Not satisfied |
| ADR6-06 least-privilege worker continues while chat is inactive | Provider invocations are charged at the engine boundary (I05); no worker | `adr6-regressions` N06 (charging); no worker tests exist | No worker is implemented; restricted tool profile and durable queue absent | Not satisfied: worker unbuilt |
| ADR6-07 independent review, acceptance and Context still block a run | Engine review, acceptance and Context paths unchanged; provider charging adds a refusal path only | Existing ADR-0003–0005 suite (full `npm test`, see the status record) | Fixture suite only. Real-provider evaluation is out of scope here | Regression-verified by the existing suite; not re-evaluated |
| ADR6-08 authorized rebuild, contained replacement and checks without manual launch | `lifecycle.mjs` phased restart: manifest verification, bounded stop with proof, launch with proof, bound observation, registration, health, UI evidence | `control-host.test.mjs` ADR6-08/11 (unconfirmed termination, changed build, image mismatch, no registration); `adr6-regressions` N09 and stop-hang | Fixture with an injected launcher. Native containment of the launched application: mechanism only (`jobguard`), not wired to the launcher. No SCM service, no Task Scheduler launch, no artifact immutability | Not satisfied |
| ADR6-09 native service crash fail-stops owned work; stable controller and unrelated work survive | Host ownership of runs through `active_work`; native Job prototype | **Native:** holder crash ends the owned child and grandchild, unrelated process survives; crash between suspended creation and resume leaves nothing; leaked duplicate detected (count 2) and not trusted ([`adr6-native-job.test.mjs`](../../runtime/tests/adr6-native-job.test.mjs), 4 passing). **Fixture:** owned work across host restart | Native evidence for the Job mechanism on this machine. Not verified: the SCM service holding the handles, Deszo's per-run/application Job topology, a Deszo preview controller as the stable process (a generic Node process was used), and PID-reuse identity | Partially evidenced; not satisfied |
| ADR6-10 injected crashes, lost replies and leaks reconcile without duplicates | Bounded lifecycle calls; reconciling outcomes; launch proof issued once; retry replay (I08) | `adr6-regressions` N09 (lost reply, one effect), stop-hang bounded, N05, N07; `control-host.test.mjs` ADR6-10 (restart during an operation) | Fixture. Native holder-crash and leak injection only (see ADR6-09) | Partially evidenced; not satisfied |
| ADR6-11 wrong build, store, protocol, user or session, locked desktop and missing UI evidence block | Identity checks (manifest digests, image digest, process session, health protocol and store), UI evidence bound to pid and generation | `control-host.test.mjs` ADR6-08/11 (changed build and image), `adr6-regressions` N04 (desktop and mode refusals) | Fixture. No native UI automation, no locked-desktop test | Not satisfied |
| ADR6-12 rollback needs authority and a compatible restore; newer data preserved | `app.rollback` is an authorized operation kind only | None | None: no rollback or restore strategy is implemented | Not satisfied |
| ADR6-13 all linked attempts and lifecycle operations consume shared limits | Attempts charged at run creation; `provider.invoke` per invocation (I05); restarts, builds and repairs charged at decision; minimum costs enforced | `adr6-regressions` N06 (provider limit); `control-host.test.mjs` ADR6-13 (shared limits, minimum cost raised) | Fixture. Repair cycles and worker calls are not charged (not implemented) | Partially evidenced; not satisfied |
| ADR6-14 audit reconstructs consent, decisions, operations and lineage with independent evidence | Hash-chained `audit_events`, `sessionIndex`, `verifyAudit`, owned-work and release records | `control-host.test.mjs` ADR6-14 (altered history detected) | Fixture. The chain is not an adversarial guarantee in a same-user writable store; no independent pilot record | Not satisfied |
| ADR6-15 one valid session reaches a verified feature branch after controlling-Deszo replacement | None end to end | None | **Not run.** Requires an enabled production host (gates unverified), a verified consent procedure (a physical authenticator), the protected service and launcher, real provider runs and native UI evidence | Not satisfied; not attempted |

## Enablement gates

The ten production capabilities in [`capabilities.mjs`](../../runtime/host/capabilities.mjs) are unverified. A production host refuses to start, so no autonomous authority can be granted through this code path. Fixture hosts remain available to tests only.

## What must happen before any criterion can be claimed

1. Build and verify the protected service (SCM, dedicated SID, ACLs) and the named-pipe security descriptor with client verification; this needs an administrator to install.
2. Verify a consent broker with fresh user verification and protected display; this needs a physical authenticator.
3. Wire the native Job prototype into the service, as the owner of the launch handle, and test the Deszo topology.
4. Build the Task Scheduler launcher, the restricted worker and rollback; then run the pilot (ADR6-15) under an approved policy.
