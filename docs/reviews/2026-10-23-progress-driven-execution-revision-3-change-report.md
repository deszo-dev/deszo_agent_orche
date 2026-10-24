# Revision 3 Change Report: Progress-Driven Execution and Conditional Invocation Preservation

**Date:** 2026-10-23  
**Artifact:** [Architecture Amendment Proposal, Revision 3](2026-10-23-progress-driven-execution-amendment-revision-3-en.md)  
**Status:** Proposal only. No ADR was accepted or amended by this work, and no runtime or Host behavior was changed.

## Summary

Revision 3 incorporates the four agreed corrections to Revision 2. It separates changes that fit the current hard limits from the proposed resource-policy change, makes deadline-free invocation provider-specific, defines a bounded and single-use Judge decision, and specifies where Process Custody would keep evidence while the Engine is absent. The existing desktop restart behavior remains the verified baseline; preservation of a live CLI remains conditional on a separate proof and acceptance decision.

## Changes made

| Area | Revision 3 change | Reason |
|---|---|---|
| Adoption sequence | Split the former Stage 1 into **Stage 1A**, which retains all existing hard caps, and **Stage 1B**, which requires a separate amendment to accepted ADR-0003. Separated the proposed decision-register entries for Stage 1A, Stage 1B, and conditional Process Custody. | Revision 2 listed the resource-policy change as requiring separate approval while including it in the first implementation stage. |
| Resource accounting | Specified which aggregate limits a future policy might explicitly omit, preserved existing plans, and retained accounting for assessment, discovery, implementation, checks, repair, review, Context/Judge use, delivery, and smoke tests, including failed or uncertain work. | Changing a hard cap must not erase expenditure or reset it through repair or restart. |
| Invocation deadline modes | Defined versioned `bounded` and `unbounded` modes. `unbounded` requires executable verification for the exact provider, CLI version, and adapter version; unsupported requests fail before launch. Existing `timeoutSeconds` values and managed-task deadlines retain their behavior. | Removing the Engine timer alone cannot establish that a provider adapter supports an invocation without a deadline. The current Antigravity adapter requires a positive timeout. |
| Judge decision | Replaced a general continuation permission with a typed proposal for one action from a closed set. The Engine creates `stagnationEpisodeId` and the validated, single-use `grantId`; the Judge references the episode and supplies evidence, a hypothesis, preconditions, and expected evidence. The grant is consumed atomically with admission of its action. | Model output must not mint its own authority or cause duplicate dispatch on replay. |
| Finite stagnation handling | Added a finite per-episode allowance for unsuccessful Judge-authorized actions, with two as an initial policy candidate. A new episode requires objective progress against a criterion fixed before the action. Exhaustion leads to external input or a permitted terminal outcome; an unavailable Judge leaves a technical blocker. | Rejecting only identical `CONTINUE` text would still permit an endless sequence of renamed hypotheses. |
| Launch boundary | Required a durable invocation intent and `attemptId` before an authenticated, narrow launch permit reaches Custody. Custody records permit acceptance before spawn, returns the existing invocation on replay, and reconciles an uncertain launch rather than spawning again. | The guarantee is at most one physical launch per permit, with uncertainty reported when a crash prevents proof. |
| Durable capture | Added a Host-owned spool outside replaceable Deszo versions. It records raw stream segments, identities, offsets, digests, capture frontier, gaps, ownership generations, and terminal receipts. The Engine imports and commits evidence before acknowledging Custody; replay is idempotent. | The original proposal did not locate output captured while the Engine was unavailable. |
| Retention and failure semantics | Spool cleanup waits for verified durable import, outcome reconciliation, artifact integrity, and ADR-0002 retention requirements. The proposal guarantees only confirmed durably written bytes; an unknown tail after a Custody or OS crash is recorded as a gap. | A claim of unconditional lossless capture would exceed the defined failure model. |
| Independent enforcement | Required Custody to honor Stop, applicable invocation and aggregate elapsed-time hard deadlines, and process ownership while the Engine is unavailable. | A preserved CLI must not outlive an already applicable hard boundary merely because the Engine restarted. |
| Evidence plan | Expanded the PoC with failures before spawn, after spawn but before acknowledgement, after terminal commit but before acknowledgement, and during Engine absence at Stop or deadline. Added acceptance checks for provider support, Engine-issued Judge identities, permit idempotency, spool import, retention, and arbitrary Host-spawn rejection. | These are the boundaries most likely to create duplicate execution, lost evidence, or an unauthorized command path. |

## Repository facts used

- Current validation caps Agent `timeoutSeconds` at 600 seconds ([validate.mjs](../../runtime/core/validate.mjs)); the Engine enforces a node or managed-task deadline in `runProcess()` ([engine.mjs](../../runtime/core/engine.mjs)).
- The Antigravity adapter requires a positive process timeout and passes `--print-timeout` to the CLI ([adapters.mjs](../../runtime/core/adapters.mjs)).
- Accepted ADR-0003 currently requires aggregate attempt and elapsed-time bounds ([ADR-0003](../adr/0003-task-assessment-and-workflow-planning.md)).
- Proposed ADR-0009 already blocks routine dispatch on deterministic stagnation and routes to Judge or a blocked state ([ADR-0009](../adr/0009-workflow-native-judge-and-exclusive-external-input.md)).
- Desktop Proof B verified Host-driven Tauri replacement while terminating the existing provider tree ([Proof B](2026-10-23-desktop-host-proof-b.md)). Revision 3 does not report live-CLI preservation as implemented.

## Remaining decisions and verification

1. Whether to accept Stage 1B's optional absence of specific hard caps requires an explicit product and ADR-0003 decision. The existing bounds remain authoritative until then.
2. Process Custody requires its own PoC and later desktop Proof C before it can become a production architecture. A successful PoC does not by itself accept ADR-0008 or ADR-0009 or imply support on every platform or provider.
3. The proposed initial allowance of two unsuccessful Judge-authorized actions is a policy candidate to validate, not a measured universal limit.

This was a documentation-only revision. No provider calls, implementation changes, or runtime acceptance tests were performed for Revision 3.
