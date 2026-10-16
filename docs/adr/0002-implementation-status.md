# ADR-0002 implementation status

Date: 2026-10-16  
Subject: [ADR-0002](0002-execution-audit-and-supervised-control.md)  
Review addressed: [implementation review](../reviews/2026-10-16-adr-0002-implementation-review.md)  
Status: Stages 1–4 implemented and verified locally, including the review's findings. Live client verification, real-provider probes and the shadcn/ui pilot are not run.

## What is implemented

| Stage | Implemented | Verified by |
| --- | --- | --- |
| 1. Contracts | Migration `m8.sql` (execution evidence, termination proofs, controller sessions with hashed credentials, control grants pinned to a workflow revision, observation acknowledgements, incidents and their updates, audit exports). Journal-v2 branches for stream closure, execution evidence, termination proofs and grant changes, byte offsets on chunks, the `capture_limit` code and grant extensions. Schemas `execution-evidence`, `incident`, `audit-manifest` and `run-control-api`. Client tool-timeout registry `docs/authoring/client-timeouts.json`, unverified for every client. | `npm test`, `docs:check` |
| 2a. Durable capture | `runtime/core/streams.mjs` records every Agent and check stream as ordered chunks with offsets, a manifest and a closure event. A hard bound stops the process with an explicit `capture_limit` failure. Every check outcome writes an evidence record with its command manifest and stream manifests. | `supervision.test.mjs` |
| 2b. Native containment | `src-tauri/src/bin/launch_shim.rs`: the shim obtains the run Job over an authenticated rendezvous, creates the CLI suspended, assigns it, resumes it, then returns its exit code. It passes only the three stdio handles to the CLI through an explicit handle list, and copies a non-inheritable stdio handle as an inheritable one first. Its own failures use exit codes a CLI does not return. `src-tauri/src/supervisor.rs`: named control pipe with `FILE_FLAG_FIRST_PIPE_INSTANCE` and `PIPE_REJECT_REMOTE_CLIENTS`, one kill-on-close Job per run, a PID-bound and single-use rendezvous and result, a monotonic escalation clock, a separate runtime-liveness clock, and a per-run emergency credential. | `cargo test`: the containment test runs a real shim, checks the CLI is a Job member, proves the Stop and expects zero members; the emergency test checks the credential and the drain |
| 2c. Verified root Stop | Every root Stop records a termination proof: `stopped` only with native zero-member proof, otherwise `termination_unconfirmed`. An unknown supervisor record is unconfirmed, never zero. A confirmed proof releases the run Job. | `supervision.test.mjs` |
| 3. Observation and control | `watch_run` (bounded long poll, clamped to a provisional 20 s), `ack_run_observation` with lag, byte-exact `read_artifact_range` (base64, 64 KiB), control grants (request with a session credential and a pinned revision, first-party decision, binding before the first launch with a matching credential and revision, revocation that stops the run), a watchdog that pauses dispatch and raises `controller_unresponsive`, native escalation that the runtime records and stops, and a first-party escalation extension confirmed by the supervisor. A refused arm revokes the grant and stops the run after exactly one arm request. `controlMode` appears on the run snapshot and control endpoint. | `supervision.test.mjs` |
| 3c. Incidents | Local registry with an immutable initial observation and append-only updates. Authority and session come from the caller's credential, not the body. Triage, cause confirmation and closure are first-party only. `stop_and_report` commits the barrier and the incident in one transaction; if the report cannot be stored, Stop still runs and the report is spooled. A spool file is written atomically, a retry overwrites the same entry, and an unreadable file is quarantined and recorded as a capture gap instead of blocking startup. | `supervision.test.mjs` |
| 3d. Emergency channel | The supervisor issues a credential per run with the arm. The runtime holds it in memory and gives it only to the granted controller, through a route that requires the session credential. The bridge keeps it in memory, and `emergency_stop` reaches the supervisor over its own pipe without the runtime. `status` reads containment health with the same credential. The bridge queues a report it cannot send, with its request ID, and replays it on a later call. | `supervision.test.mjs` (credential route), `supervisor-pipe.test.mjs` (protocol against a real pipe), `cargo test` (emergency drain) |
| 4. Audit export | `create_audit_bundle` writes a pinned bundle with a manifest of every member's size and digest, the reference closure, a verdict, omissions and a redaction manifest. The shareable profile omits raw process streams and declares it. `get_command_status` reconciles uncertain writes. | `supervision.test.mjs` |

## Review findings

| Finding | Status |
| --- | --- |
| ADR2-I01 shim not installed | Fixed. `npm run shim:build` builds it release-mode and copies it into `dist-runtime`, which is bundled. `npm run shim:dev` builds the development copy, and `desktop` runs it first. The app refuses to start without the shim and says how to build it. The Node side also refuses a missing shim. |
| ADR2-I02 refused arm crashes | Fixed. The synchronous `armRun` call is gone; the only arm is awaited, and a refusal reaches `failArm`. Test: one arm request, grant revoked, run stopped, no unhandled rejection. |
| ADR2-I03 sessions unauthenticated | Fixed. A session gets a credential once; only its hash is stored, and a replayed request never returns it. Acknowledgements, grant requests, grant binding and the emergency credential all require the session's credential. Incidents and acknowledgements record the authenticated session. The bridge keeps the credential in memory and never returns it to the model. |
| ADR2-I04 grants not pinned | Fixed. A grant pins the workflow snapshot hash at request time, and binding refuses a different revision. |
| ADR2-I05 emergency channel missing | Built, with the gates below. Per-run credential, runtime-independent stop and health, bridge queued receipts. |
| ADR2-I06 spool blocks startup | Fixed. Atomic writes, overwrite on retry, quarantine with a capture-gap incident. |
| ADR2-I07 false stop proof | Fixed. Unknown supervisor records are unconfirmed. |
| ADR2-I08 one liveness clock | Fixed. The runtime heartbeats every second on its own clock; the supervisor stops a run whose runtime has been silent for 15 s, and the controller's acknowledgements do not affect that clock. |
| ADR2-I09 token leaks to probes | Fixed. The supervisor variables are read once and removed from the environment before any probe runs. |
| ADR2-I10 pipe, result, handles, exit codes | Fixed. Both pipe flags are set. A `result` is accepted only from the bound PID and is spent once. The CLI inherits only the stdio handles. Shim failure codes are `0x7DE50120`–`0x7DE50122`, mapped to spawn failures only under a supervisor. |
| ADR2-I11 status record | This file now lists the emergency channel, the session credentials and the grant pin. |

## Gates that remain open

- **Client timeout matrix (ADR2-10).** `client-timeouts.json` is unverified for Codex, Claude Code and Antigravity, so every supervision grant is refused with `supervision_unavailable`. No supervised run can be created until each client's per-server MCP tool timeout is measured and recorded.
- **Confirmation.** A supervised request with confirmation on is refused with `confirmation_required`. The review requires this limit to be lifted before confirmation becomes the default, or the pilot cannot run supervised.
- **Live verification (Stage 5).** No live client, real-provider probe or shadcn/ui pilot has been run. Each needs a separate instruction.
- **Hung-runtime path.** The emergency stop, the runtime-silence hard stop and the bridge's queued receipts are each tested in isolation. None has been run against a real supervisor with a hung runtime and a live bridge.
- **Installed build.** The shim is bundled by the release scripts and checked at startup. An installed build has not been produced and launched.
- **Watch wait.** `MAX_WATCH_WAIT_MS` is provisional. It must sit strictly below every measured client tool timeout, and the bridge's HTTP timeout must exceed it.

## Route authority

Enforced in `runtime/runner.mjs` (`firstPartyOnly`). Every write records the authority the caller holds.

| Route | Authority |
| --- | --- |
| `POST /api/v2/controller-sessions` | external or first-party; the credential is returned once |
| `POST /api/v2/control-grants` | external, with the session credential; refused with `supervision_unavailable` until supervision is available and the client matrix is verified |
| `POST /api/v2/control-grants/{id}/decision`, `/revoke` | first-party only |
| `GET /api/v2/control-grants/{id}`, `GET /api/v2/runs/{id}/control` | read |
| `GET /api/v2/runs/{id}/emergency-credential` | the granted session's credential |
| `GET /api/v2/runs/{id}/watch`, `GET /api/v2/runs/{id}/evidence`, `GET /api/v2/runs/{id}/processes` | read |
| `POST /api/v2/runs/{id}/observation-acks` | the grant's session credential when a grant is active |
| `POST /api/v2/runs/{id}/control-extension` | first-party only |
| `POST /api/v2/runs/{id}/stop-and-report` | external or first-party |
| `POST /api/v2/incidents`, `POST /api/v2/incidents/{id}/observations` | external or first-party; a presented session credential is recorded |
| `POST /api/v2/incidents/{id}/triage` | first-party only |
| `GET /api/v2/incidents`, `GET /api/v2/incidents/{id}` | read |
| `POST /api/v2/runs/{id}/audit-bundles`, `GET /api/v2/audit-bundles/{id}` | external or first-party |
| `GET /api/v2/artifacts/{id}/range`, `GET /api/v2/command-status/{requestId}` | read |

The MCP bridge registers the read and filing tools by default. The grant, acknowledgement, session, emergency and stop-and-report tools need `--allow-execution`, as the existing `start_run` and `stop_run` do.

## Not built

- Desktop Bugs/Incidents view and the Deszo-window controller notice and extension controls.
- Declared diagnostic attachments captured before cleanup.
- The native CLI transcript collector.
- Execution evidence records for Agent attempts. Agents have stream manifests and closure events; their evidence record is not yet written.
- Reasoning-display identity fixtures (ADR2-04 and ADR2-09). No display setting was added.

## Follow-up review

Review: [follow-up review](../reviews/2026-10-16-adr-0002-implementation-followup-review.md) (ADR2-F01 and ADR2-F02).

| Finding | Status |
| --- | --- |
| ADR2-F02 `runtime:bundle` removes the shim | Fixed. The bundle keeps `dist-runtime/deszo-launch-shim.exe` across the rebuild, and warns when no shim is present. A release build still runs `shim:build` after the bundle. |
| ADR2-F01 heartbeat stalls behind synchronous work | Fixed by removing the long synchronous work. Audit bundles now stream each object's hash, copy it asynchronously, and yield during the journal walk; only the receipt and rows commit in the transaction. Measured worst event-loop stall while building a bundle with a 64 MiB object: 38 ms on this machine (test `building an audit bundle with a 64 MiB object keeps the event loop responsive`). The 15-second silence threshold is therefore far above the measured stall for that workload. Other synchronous work (SQLite transactions, journal projection) has not been measured under large runs. |
| Note: emergency credential fetched only on request | Fixed. The bridge fetches a supervised run's emergency credential in the background when the run starts and on each acknowledgement, retrying while the supervisor arms the run. `prepare_emergency_stop` remains for an explicit refresh. |

Two items are still open. The hung-runtime path has not been run against a real supervisor, bridge and hung runtime together. The installed build has not been produced and launched.
