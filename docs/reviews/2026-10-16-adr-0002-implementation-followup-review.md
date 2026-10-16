# ADR-0002 implementation follow-up review

Date: 2026-10-16  
Subject: fixes for the [implementation review](2026-10-16-adr-0002-implementation-review.md), as recorded in the [implementation status](../adr/0002-implementation-status.md)  
Verdict: **All eleven findings are addressed and the reported checks reproduce.** Two new low-to-medium items follow from the fixes themselves. Stage 5 and the `confirmation_required` limit remain gated, as recorded.

## Verification

All checks were rerun independently. None invokes a provider or uses quota.

| Check | Result |
| --- | --- |
| `npm test` | 404 / 404 pass |
| `cargo test --locked` | 10 + 4 pass, including the real shim inside a per-run Job and the separate runtime-heartbeat test |
| `npm run build`, `npm run docs:check` | Pass |
| Spool probe: a truncated spool file in a fresh root | **Fixed.** The runtime starts, the file is moved to `spool/incidents/quarantine`, and a `capture_gap` incident is recorded |
| Arm-rejection probe | My earlier probe no longer applies, because sessions now need a token hash and grants a snapshot. The code shows a single awaited `armRun` whose rejection goes to `failArm`, and the suite asserts exactly one arm request |

## Status of implementation-review findings

| Finding | Status |
| --- | --- |
| ADR2-I01 shim not installed | Fixed. `shim:build` copies the shim into `dist-runtime`, which `tauri.conf.json` bundles as `runtime/`. `desktop` runs `shim:dev` first. `launch_shim()` refuses to start the runtime with build instructions when the shim is missing. See ADR2-F02 |
| ADR2-I02 unhandled arm rejection | Fixed. The duplicate synchronous call is removed |
| ADR2-I03 unauthenticated sessions | Fixed. A session credential is issued once and only its hash is stored. `requireControllerCredential` gates grant requests, binding, acknowledgements (whenever a grant exists) and the emergency credential. The bridge keeps the token in memory |
| ADR2-I04 snapshot pinning | Fixed. Binding refuses a different `workflow_snapshot_sha256` |
| ADR2-I05 emergency channel | Implemented. `emergency_stop` and `emergency_status` take a per-run credential issued on arm and fetched through a credential-gated route. The bridge reaches the supervisor pipe directly, and queues unsent reports next to the connection file for replay with the same request IDs. See the note on `prepare_emergency_stop` below |
| ADR2-I06 spool robustness | Fixed and probe-verified |
| ADR2-I07 false proofs | Fixed. An unknown run returns `remainingMembers: null, known: false` |
| ADR2-I08 one clock | Fixed. A separate `runtime_alive` clock stops armed runs after 15 s of runtime silence, independent of controller acknowledgements. See ADR2-F01 |
| ADR2-I09 token leak | Fixed. The supervisor variables are deleted from the environment when read |
| ADR2-I10 hardening | Fixed. `PIPE_REJECT_REMOTE_CLIENTS` and `FILE_FLAG_FIRST_PIPE_INSTANCE` are set. `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` passes only stdio. Results are bound to the PID and spent once. Failure codes moved to `0x7DE50120`–`0x7DE50122` |
| ADR2-I11 status completeness | Fixed. The status record lists each finding and the route-authority table |

## New findings

### ADR2-F01 (low-medium): a long synchronous runtime task can trip the 15 s liveness stop for every supervised run

The runtime heartbeat is a 1 s `setInterval` on the Node event loop ([engine.mjs:96](../../runtime/core/engine.mjs)). Several engine operations are synchronous: SQLite transactions, synchronous file I/O and hashing. `createAuditBundle` in particular builds and hashes the whole bundle inside one idempotent transaction ([supervision.mjs:598](../../runtime/core/supervision.mjs)), and the ADR explicitly allows an active-run bundle during a pilot.

If such work blocks the loop for more than 15 s, the supervisor treats the runtime as lost and terminates **every** armed run's Job. That is a hard stop with "runtime lost", caused by a healthy runtime doing its own work.

Fix, either:

- move heartbeats onto a `worker_threads` worker, or onto native code that observes the main loop's progress through a shared counter; or
- make bundle building and hashing incremental and asynchronous, then add a test that a large active-run bundle does not trip liveness.

Also record the measured worst-case loop stall in the Stage 5 matrix before relying on 15 s.

### ADR2-F02 (low): running `runtime:bundle` alone silently removes the bundled shim

`bundle-runtime.mjs` starts with `rmSync(dist-runtime, { recursive: true })`, and the shim is copied in only by `shim:build`. `desktop:build` runs them in the right order. But a standalone `npm run runtime:bundle`, a common step after runtime edits, leaves `dist-runtime` without the shim, and a later `tauri build` produces an app that refuses to start. The current `dist-runtime` has no shim, for exactly this reason.

Fix: have `bundle-runtime.mjs` preserve or re-copy an existing release shim, or fail `tauri build` through a `beforeBuildCommand` check when `dist-runtime/deszo-launch-shim.exe` is missing.

### Note: preparing the emergency credential is up to the model

The emergency path works only if the controller has already called `prepare_emergency_stop` for the run while the runtime still answered. If the model never calls it, a hung runtime leaves only the escalation deadline. This is not a defect, but it is a reliability gap for the D21 scenario. Have the bridge fetch the credential automatically after a successful supervised `start_run`, or on the first `watch_run` for a supervised run, and keep the explicit tool as a fallback.

## Still gated, correctly recorded

- **`confirmation_required` for supervised requests while confirmation is on.** It must be lifted before confirmation becomes the default after the ADR-0001 rerun.
- **The client timeout matrix is unverified.** Every grant is refused, so no supervised run can start yet.
- **Live verification has not happened:**
  - a hung runtime with a real supervisor and a live bridge;
  - a real 15 s silence trip;
  - an installed build;
  - live clients;
  - real-provider probes;
  - the shadcn/ui pilot.
- Stage 5 as a whole.

## Recommendation

Fix ADR2-F02 before the next packaged build. Fix ADR2-F01, or at least measure it, before any supervised run, because the 15 s stop is a hard stop for all supervised work. Neither blocks merging the fixture-verified implementation, provided the status record keeps Stage 5 gated.
