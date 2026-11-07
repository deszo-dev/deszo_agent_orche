## Summary

Implements [ADR-0002](https://github.com/deszo-dev/deszo_agent_orche/blob/codex/shadcn-ui/docs/adr/0002-execution-audit-and-supervised-control.md) through Stage 4: lossless execution evidence, externally supervised runs with a native watchdog and verified per-run Stop, local product incidents, and offline audit bundles. Status per stage and per review finding is in [0002-implementation-status.md](https://github.com/deszo-dev/deszo_agent_orche/blob/codex/shadcn-ui/docs/adr/0002-implementation-status.md).

## What changed

- **Capture.** `runtime/core/streams.mjs` publishes Agent and check output as ordered, journaled chunks with byte offsets, replacing the 1 MiB check buffer. A hard bound is an explicit `capture_limit` failure. Every check outcome writes an execution-evidence record.
- **Containment.**
  - The native launch shim (`src-tauri/src/bin/launch_shim.rs`) creates each CLI suspended, assigns it to a per-run Job owned by `supervisor.rs` and nested under the application Job, then resumes it.
  - Root Stop records a termination proof. A run the supervisor does not know reports unknown, never zero members. Runs without native containment report `termination_unconfirmed`.
- **Supervision.**
  - Bounded `watch_run` and range reads.
  - Credentialed controller sessions; only the token hash is stored.
  - Grants pinned to a workflow snapshot.
  - A watchdog that pauses dispatch before native escalation.
  - A separate runtime-liveness clock.
  - First-party deadline extensions.
  - An emergency Stop channel from the bridge to the supervisor pipe.
- **Incidents and audit.**
  - `stop_and_report`.
  - An atomic incident spool that quarantines bad files.
  - First-party-only triage.
  - Private and shareable hash-verified audit bundles, built asynchronously.
- **Contracts.** Migration `m8.sql`; new journal events; new `execution-evidence`, `incident`, `audit-manifest` and `run-control-api` schemas; additive `controlGrantId` and `controlMode` on existing v2 routes.
- **Build.** `npm run shim:dev` / `shim:build`. `desktop` builds the shim first, `runtime:bundle` keeps an existing shim, and the app refuses to start without one.

## Review trail

Design and implementation reviews are in `docs/reviews/2026-10-16-adr-0002-*.md`. All implementation and follow-up findings are resolved; the closure review records the remaining gates.

## Verification

All local, with fixture CLIs; no provider calls or quota used:

- `npm test` 405/405
- `cargo test --locked` 10 + 4
- `npm run build`, `npm run runtime:bundle`, `npm run docs:check`

## Reviewer notes

- **Not live-verified.** The hung-runtime path has not been run against a real supervisor, bridge and runtime together. No installed build has been produced and launched, and no live client, real-provider probe or pilot has run. Stage 5 stays gated.
- **Supervision is fail-closed.** Every grant is refused with `supervision_unavailable` until the client tool-timeout matrix (`docs/authoring/client-timeouts.json`) is verified. Supervised requests are refused with `confirmation_required` while external-run confirmation is on; that limit must be lifted before confirmation becomes the default.
- **The 15 s runtime-liveness stop is a hard stop for all supervised work.** Measure the worst event-loop stall during a long run before relying on it. Only the audit-bundle path has been measured, at 38 ms on the implementer's machine.
- **One existing Rust test changed.** `descendants_survive_the_direct_child_until_the_job_is_drained` now starts one long-lived descendant, removing a race.
- **Branch name.** This branch is `codex/shadcn-ui`, but it carries ADR-0002 infrastructure, not the shadcn/ui migration itself. The pilot brief names this branch as the destination for the pilot's accepted candidate.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
