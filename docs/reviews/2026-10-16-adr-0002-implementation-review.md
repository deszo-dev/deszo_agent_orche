# ADR-0002 implementation review

Date: 2026-10-16  
Subject: the ADR-0002 implementation through Stage 4, recorded in the [implementation status](../adr/0002-implementation-status.md)  
Verdict: **The reported checks reproduce and the core mechanisms are real, but the change is not shippable.**

- Under the desktop supervisor, every run now depends on a shim binary that packaging does not install.
- A refused arm crashes the runtime.
- Controller sessions carry no credential.
- The ADR's emergency control channel does not exist, and the status record does not say so.

## Verification

All checks were rerun independently. None invokes a provider or uses quota.

| Check | Result |
| --- | --- |
| `npm test` | 391 / 391 pass |
| `cargo test --locked` | 8 + 4 pass, including the real shim run inside a per-run Job, drained to zero members |
| `npm run build`, `npm run runtime:bundle`, `npm run docs:check` | Pass |
| Probe: supervisor rejects `armRun` during `bindControlGrant` (fixture runner, scratchpad) | `armRun` called **twice**, with **one unhandled rejection**. The grant ends `revoked` only through the second call |
| Probe: a truncated spool file in a fresh root | `startRunner` fails with "Unterminated string in JSON". The runtime cannot start |

Confirmed by reading the code:

- [streams.mjs](../../runtime/core/streams.mjs) captures losslessly in ordered chunks, journals byte offsets, and has an explicit `capture_limit`.
- [launch_shim.rs](../../src-tauri/src/bin/launch_shim.rs) creates the CLI suspended, assigns it to the run Job, and only then resumes it. The Job handle is assign-only, non-inheritable and duplicated per PID. The rendezvous checks that the pipe client's PID is the bound shim.
- [supervisor.rs](../../src-tauri/src/supervisor.rs) uses kill-on-close run Jobs and a monotonic escalation clock.
- `launch()` strips the supervisor variables from CLI environments.
- The watchdog pauses dispatch and records an incident, then escalates through the supervisor. Extension is first-party only, receipted, and confirmed by the supervisor.
- Triage is first-party only.
- Without native containment, the termination proof reports `termination_unconfirmed`.

## Findings

### ADR2-I01 (high): every desktop run now depends on a shim that is not installed

`launchContained` sends **every** process of a supervised runtime through the shim, including ordinary unsupervised runs. That runtime is always the Tauri app. [main.rs](../../src-tauri/src/main.rs) sets `DESZO_LAUNCH_SHIM` to `deszo-launch-shim.exe` next to the app executable without checking that it exists, and `supervisorFromEnvironment` does not check either. The status record says nothing places the shim there. `tauri.conf.json` has no `externalBin`, and the NSIS bundle ships only the main binary and resources.

The consequence is that every workflow in an installed build fails to spawn. The same happens in `tauri dev` unless a separate `cargo build` or `cargo test` happened to leave the shim in `target/debug`. The status record lists packaging as a gap but not this regression to ordinary runs.

Fix, in either order:

1. Ship the shim: Tauri `bundle.externalBin` or resources, plus a packaged-app check.
2. Have the supervisor verify the shim at startup. If it is missing, either refuse to start the runtime with a clear error, or deliberately run ordinary runs unsupervised with direct spawn, `controlMode: "unsupervised"` and an unconfirmed Stop. Supervised grants keep failing closed either way.

### ADR2-I02 (high): a refused arm is an unhandled rejection, which terminates the runtime

`bindControlGrant` ([supervision.mjs:132](../../runtime/core/supervision.mjs)) calls `this.supervisor.armRun(…)` inside a `try` without awaiting it, so the `catch` can never see a rejection. It then calls `armRun` again at line 140. When the supervisor refuses or the pipe drops, the first promise rejects unhandled. The probe confirmed this, and under Node 22's default `unhandledRejection` mode the runtime process exits. The existing test checks only `supervisor.arms[0]`, which hides the duplicate call.

Fix: remove the synchronous call at line 132 and keep the awaited path through `failArm`. Assert in the test that exactly one arm is made, and add a rejecting-supervisor case.

### ADR2-I03 (medium, security): controller sessions are unauthenticated identifiers

The ADR requires the grant to be bound "to an authenticated session, not merely a caller-provided label or bridge ID", with a controller credential held in bridge memory. In the implementation:

- `createControllerSession` returns only an ID; there is no secret.
- `acknowledgeObservation` accepts any external-token caller for any run and renews the supervisor heartbeat.
- `createRun` with `controlGrantId` does not check that the caller owns the grant's session.

Any bridge or local process holding the external token can therefore keep a supervised run's watchdog alive in place of the real controller, which defeats the attention lease, or can launch a run under someone else's approved grant.

Fix:

- Issue a session secret at creation and store only its hash.
- Require it on acknowledgements, on binding a grant to a run, and on grant-scoped commands.
- Record the authenticated session on every write, as incidents already do.

### ADR2-I04 (medium): grants are not pinned to a workflow snapshot

`requestControlGrant` stores `workflowSnapshotSha256: null`, and `bindControlGrant` matches only the workflow and workspace IDs. The ADR's grant covers "an exact run request/workflow snapshot/workspace identity". As implemented, the user approves supervision of one revision, and the grant can then start a later revision saved through the authoring API. Require the snapshot hash in the grant request, show it in the approval, and refuse to bind on mismatch.

### ADR2-I05 (medium): the emergency control channel and bridge-side pending incidents are missing

ADR §4 and Stage 3 require a narrowly authenticated supervisor channel that a **granted bridge** can reach without the Node HTTP event loop, for emergency Stop and containment health. ADR §5 adds a bridge-held pending incident receipt for when the runtime is unavailable.

Today the supervisor pipe accepts only the runtime's token, and the bridge has no supervisor path. With a hung runtime, the only remaining safety is the escalation deadline. The controller cannot stop the run, and `stop_and_report` cannot work. The status record and the implementation summary do not list this gap.

Fix: implement the channel (per-grant credential, run-scoped operations only), or record it explicitly as unbuilt Stage 3 scope.

### ADR2-I06 (medium): the incident spool can block runtime startup

`reconcileIncidentSpool` runs first in `initialize()`. It parses every spool file with an unguarded `JSON.parse`, and `spoolIncident` writes with a plain `writeFileSync`. A crash or full disk mid-write, the condition the spool exists for, leaves a truncated file, and the probe shows the runtime then refuses to start. A retried `stop_and_report` on the persistence-failure path also throws `EEXIST`, because the spool uses `flag: 'wx'`.

Fix:

- Write spool files through a temporary file and rename, so a crash cannot leave a partial file.
- Move unparseable files to a `quarantine/` folder and record a capture-gap incident, rather than stopping startup.
- Treat an existing spool file for the same derived incident ID as an idempotent success.

### ADR2-I07 (medium): `prove_stopped` reports zero members for a run it never contained

In [supervisor.rs](../../src-tauri/src/supervisor.rs) `control`, `prove_stopped` returns `remainingMembers: 0` when the run is unknown. That includes a run released earlier, a run whose `bind_shim` never arrived, and a run from before a supervisor restart. The runtime then records `stopped` with containment `windows-job`. This is the fabricated success the ADR forbids ("never fabricated success"). Return `not_found`, and let the runtime record `termination_unconfirmed` with that reason.

### ADR2-I08 (low): runtime liveness and controller attention share one clock

The supervisor's `last_heartbeat` is renewed only by controller acknowledgements relayed by the runtime. A hung runtime and a silent controller therefore look identical, so escalation cannot tell them apart. ADR §2 asks for "Distinguish healthy long provider work from absent controller acknowledgements and from an unresponsive runtime", and for a separate native runtime-liveness check. Add a runtime liveness heartbeat with its own deadline and reason, and report which of the two expired.

### ADR2-I09 (low): the supervisor token reaches CLI detection probes

`launch()` filters `SUPERVISOR_ENV`, but other spawn paths copy `process.env`:

- `capture()` in [adapters.mjs](../../runtime/core/adapters.mjs), through `subscriptionEnvironment()`, used for CLI version and status detection;
- `processStartTime` in `processes.mjs`, which starts PowerShell.

Read the three variables once at startup and delete them from `process.env`, so no future spawn path can leak them.

### ADR2-I10 (low): native hardening and protocol details

- **Named pipe flags.** The pipe is created without `PIPE_REJECT_REMOTE_CLIENTS` or `FILE_FLAG_FIRST_PIPE_INSTANCE`. Add both.
- **Unauthenticated `result` op.** `result` requires no token, and rendezvous entries are never removed. Bind `result` to the rendezvous PID, as `rendezvous` is, and delete entries after use.
- **Handle inheritance.** The shim calls `CreateProcessW` with `bInheritHandles = TRUE`, so the CLI inherits every inheritable handle, not only stdio, despite the comment. Use `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to pass exactly the three stdio handles.
- **Exit-code collision.** Shim failure codes 120–122 collide with legitimate CLI exit codes. Classify shim failures from the supervisor's `result` record or a distinct stderr marker, not from the code alone.

### ADR2-I11 (low): status record completeness

The status record correctly lists as unbuilt or unverified:

- the UI;
- diagnostic attachments and the transcript collector;
- Agent evidence records;
- reasoning-identity fixtures;
- shim packaging;
- live verification.

It should add the emergency channel (ADR2-I05), session authentication (ADR2-I03) and snapshot-pinned grants (ADR2-I04).

## Decisions flagged by the implementer

| Decision | Assessment |
| --- | --- |
| Grants refused while the client timeout matrix is unverified | Correct fail-closed reading of the ADR |
| Watch wait 20 s, provisional | Acceptable, and below Codex's 60 s default. It must be finalized by the Stage 1 matrix |
| Supervised requests refused with `confirmation_required` while confirmation is on | Acceptable as a temporary limit. It must be resolved before confirmation becomes the default after the ADR-0001 rerun, or the pilot cannot run supervised |
| Changed Rust test (`descendants_survive…` now uses one long-lived descendant) | Reasonable fix for the race described |
| Additive `controlGrantId` and `controlMode`; migration test expects 8 | Consistent with the ADR |

## Recommended order

1. Fix ADR2-I01 and ADR2-I02, which break or crash the desktop runtime.
2. Fix ADR2-I06 and ADR2-I07, which affect startup robustness and false proofs.
3. Implement ADR2-I03 and ADR2-I04 before any supervised run, then ADR2-I05.
4. Address the low findings, update the status record, and keep Stage 5 gated as recorded.
