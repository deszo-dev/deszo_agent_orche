# ADR-0002 second review

Date: 2026-10-16  
Subject: [ADR-0002](../adr/0002-execution-audit-and-supervised-control.md), as revised after the [first review](2026-10-16-adr-0002-review.md)  
Verdict: **Ready for the user's acceptance decision.** All six first-review findings are resolved. The four remaining items below are precision points for the Stage 1 and Stage 2 contracts; none changes the architecture.

## Status of first-review findings

| Finding | Status |
| --- | --- |
| ADR2-01 watchdog stops on a silent assistant | Resolved. The first deadline pauses dispatch and raises a `controller_unresponsive` incident with a window notice. A fresh acknowledgement resumes. A second, longer deadline stops the run unless the user extends it in the window, and the supervisor confirms each extension against its monotonic deadline. Hard runtime failures, user Stop and grant revocation stop immediately with their own reasons. Both deadlines are chosen in Stage 1 from measured client behavior, and the acceptance scenario tests the pause, extension and escalation paths |
| ADR2-02 per-run Job membership | Resolved by choosing a native launch shim with a per-run Job nested under the application Job on Windows 8 and later. The shim creates the CLI suspended, assigns it, then resumes it and passes the Node capture pipes through unchanged. It fails closed, and Stage 2 must prove that assignment precedes resume. See ADR2-07 for the remaining contract details |
| ADR2-03 headless runtimes | Resolved. Runtimes without the Tauri supervisor, and unsupported platforms, refuse grants with `supervision_unavailable`. Unsupervised runs carry `controlMode: "unsupervised"` everywhere, and the pilot requires `"supervised"` |
| ADR2-04 reasoning display versus identities | Resolved. Display is an observation setting outside `configurationHash` and reviewer and task fingerprints; effort stays in. Parser changes use a separate capture-format version, with identity fixtures in Stage 1. See ADR2-09 for one edge case |
| ADR2-05 incident authority | Resolved. Filing and appending are allowed with the external token or a grant; triage, confirmation and closure are first-party only. Every write records its session and authority basis, and the ADR-0001 scope matrix is extended before routes are implemented |
| ADR2-06 document precision | Resolved. The header renders line by line, no numeric watch or acknowledgement defaults are fixed in the ADR, and spill-before-backpressure is specified, including how a stalled-child timeout is classified |

`npm run docs:check` passes.

## Remaining points for Stage 1 and Stage 2

### ADR2-07 (medium): the shim's Job-handle transfer and lifecycle need a contract

The shim is a child of Node, while the per-run Job belongs to the Tauri supervisor. Assigning a process requires a Job handle with `JOB_OBJECT_ASSIGN_PROCESS` rights. The contract should choose how the shim obtains it:

- **Supervisor duplicates the handle.** The supervisor calls `DuplicateHandle` into the shim, which requires a shim-to-supervisor rendezvous keyed by the shim's PID and the run's ownership generation. Access stays narrow.
- **Named Job object.** Simpler, but any process of the same account can open it and assign or terminate members. That is consistent with the stated OS-account residual, but the ADR should state it if this option is chosen.

The shim's lifecycle also needs specifying:

- It must remain the waiting parent and relay the CLI's exit code and termination, because Node tracks the shim's process, not the CLI's.
- A kill of the shim must terminate the CLI tree, which the per-run Job also guarantees.
- The termination proof must state that the shim lives outside the per-run Job, so "zero live members" refers to run work only.

Include packaging of the native binary with the runtime resources, and the failure mode when the shim is missing or blocked, for example by antivirus: a typed spawn failure, never a direct-spawn fallback.

### ADR2-08 (low): say whether verified Stop also covers unsupervised runs in the desktop app

The shim and per-run Job are introduced "for supervised process creation". Section 4 defines verified root Stop generally, but unsupervised runs in the Tauri app would still be spawned directly, with only best-effort tree termination and the app-wide Job as backstop. Either:

- use the shim and per-run Job for every run under the Tauri supervisor, keeping `controlMode` about the grant and watchdog only; or
- state that unsupervised runs report Stop as best effort, without containment proof.

The first option makes Stop behave the same for the user's own runs and costs little once the shim exists.

### ADR2-09 (low): a "display" setting that enables thinking is behavioral

The identity rule depends on display being observation only. For some providers or models, the switch that exposes thinking also *turns thinking on*, or changes its budget. Classify such a setting by its effect: anything that changes whether or how much the model reasons belongs with effort, inside the identities. Only settings verified to change rendering alone are excluded. Record the classification per provider and version in the Stage 5 matrix.

### ADR2-10 (low): pin the client tool timeout in generated configurations

The watch inequality refers to each client's *configured* MCP tool timeout, which users can change; Codex's default is 60 s and is overridable per server with `tool_timeout_sec`. Deszo cannot observe a client's effective setting. Where a client supports a per-server timeout, the generated client configuration should set it explicitly to a value above `maxWatchWait`. The setup guide should warn that lowering it below the published bound breaks `watch_run`.

## Recommendation

Accept ADR-0002 when you are satisfied with the architecture, record the acceptance against P24 in the [decision register](../DECISIONS.md), and carry ADR2-07 to ADR2-10 into the Stage 1 and Stage 2 contracts. Acceptance still authorizes no implementation and no pilot launch; each needs its own instruction.
