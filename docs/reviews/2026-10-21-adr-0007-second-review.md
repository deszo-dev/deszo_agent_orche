# ADR-0007 second review

Date: 2026-10-21  
Subject: [ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md), as amended in the [review resolution](2026-10-21-adr-0007-review-resolution.md)  
Verdict: **All five first-review findings are resolved, and the baseline is now reproducible. The ADR is ready for the user's acceptance decision.** The points below concern feasibility and evaluation rather than architecture. The most important one: as ADR7-02 is written, the first target (the user's own interactive Codex chat) may be unsatisfiable, so a dedicated registered Judge session should be named as an accepted configuration.

## Verification

| Check | Result |
| --- | --- |
| `node docs/reviews/evidence/2026-10-21-adr-0007-baseline.mjs` | Passes (exit 0). It reproduces 781 events, 689 `attempt.log_chunk`, 21 saved observation batches and the 180,000 ms legacy interval from exact-hash sources. `originalObservationFilesVerified: false` without `--originals-root`, as documented |
| Credential scan of the five evidence files | No token-, secret- or authorization-named fields with values, and no `sk-`/`ghp_` patterns. All 727 64-hex strings in the journal export sit under `sha256` (725), `executionHash` (1) and `cwdIdentity` (1), so none is a runtime bearer token. Safe to commit |
| `npm run docs:check` | Pass |

## Status of first-review findings

| Finding | Status |
| --- | --- |
| ADR7-R01 wake-up architecture | Resolved. The ADR-0006 persistent worker is the preferred adapter, behind five demonstrated properties: session continuity, usable tools, user-turn exclusion, invocation accounting and the restricted bootstrap. Managed invocations keep the marker, and removing it is forbidden. The mode stays disabled until the properties are proven |
| ADR7-R02 Watcher backstop | Resolved. Deterministic `no_progress` triggers cover repeated failure signatures, unchanged work products, repeated canonical actions and 50% of an allowance. They are evaluated atomically before repeat dispatch, are lineage-persistent and cannot be overridden by `CONTINUE`. ADR7-13 adds the always-`CONTINUE` fixture |
| ADR7-R03 baseline | Resolved, and verified above |
| ADR7-R04 deadline outcomes | Resolved. A 30 s delivery and 900 s response deadline, both anchored at request creation, lead to `waiting_for_user` for nonterminal runs. Terminal handoffs stay terminal, Stop takes precedence, and clocks never reset |
| ADR7-R05 smaller points | Resolved. Projection is incremental with yielding slices and explicit latency bounds, the Judge is generalized to a registered external controller session, and the 180 s interval with a 360 s test window is pinned |

## Remaining points

### ADR7-S01 (medium): name a dedicated Judge session as an accepted configuration

Property 3, user-turn exclusion, requires "a client-supported exclusive turn reservation atomically with authoritative checks for active/queued user turns". ADR7-02 names "the user's Codex session, not a substitute CLI session" as the first target. An interactive desktop chat that the user also types into is the hardest case to prove. Unless the Codex client exposes such a reservation, the ADR's own rule disables the mode for it permanently.

A configuration that is likely to be provable is a **dedicated registered Judge session**. That is a persistent Codex session owned by the worker, which the user reads (and may take over explicitly through a re-registration) but does not type into concurrently. Exclusion is then structural rather than racy, continuity and tool profile remain verifiable, and the Judge is still the same registered controller identity across wake-ups.

Recommendation:

- Keep the interactive chat as a goal.
- Add the dedicated session to §3 as an accepted, separately verified configuration.
- Phrase ADR7-02 so that either configuration can satisfy it, with its own evidence.

Otherwise the ADR's central benefit depends on a client feature that may not exist.

### ADR7-S02 (low): define "quiesce", and separate a busy user from a failed delivery

- **"Quiesce".** The deadline table says to "quiesce owned work" before `waiting_for_user`. State whether this means no new dispatch, with in-flight attempts finishing under their own timeouts (which matches §4's default), or Stop of in-flight work. These have very different costs for long Developer attempts.
- **A user typing in the Judge chat.** A conflicting user turn counts as missed delivery, so an escalation while the user is chatting quiesces the run after 30 s. If that is intended, say so. Otherwise give a "destination busy with the user" state its own bounded deferral, distinct from transport failure. The response deadline still caps the total.

### ADR7-S03 (low): the 50% allowance trigger makes one Judge wake-up per unfinished task routine

With the Fixer's `maxIterations: 3`, the 50% rule requests the Judge after the second completed iteration of every task not yet `READY_FOR_REVIEW`. That is reasonable policy. ADR7-12, however, demonstrates "zero routine Judge wake-ups". Classify `no_progress`/allowance wake-ups separately in the measurements, and report them per task, so the evaluation does not count these designed attention points as routine overhead, nor hide them.

### ADR7-S04 (low): size

Like ADR-0006, this record now carries protocol obligations (admission, coalescing, reconciliation and timing profiles) at contract-document detail. When Stage 1 starts, move the request, delivery and decision schemas and the supported-load profile into contract documents, and leave the ADR as the decision and its boundaries.

## Recommendation

ADR-0007 is ready for the user's acceptance decision. Before or with acceptance, add the dedicated-session configuration (ADR7-S01), because it determines whether the first real pilot can enable the mode at all. ADR7-S02 to ADR7-S04 can be settled in the Stage 1 contracts.

The evidence files are untracked, as is much of the ADR-0006 work in this tree. Commit them together with the ADR so the receipt's relative references stay valid.
