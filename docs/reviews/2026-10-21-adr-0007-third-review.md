# ADR-0007 third review

Date: 2026-10-21  
Subject: [ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md), as amended in the [final amendment resolution](2026-10-21-adr-0007-second-review-resolution.md)  
Verdict: **All second-review points are resolved, and the ADR remains ready for the user's acceptance decision.** Two interactions introduced by the amendments should be settled in the bounded PoC or the Stage 1 contracts:

- the 30 s `turn_started` deadline combined with one-turn-at-a-time serialization;
- how the dedicated session's single-writer rule is actually enforced against the user's own Codex client.

Neither changes the architecture.

## Status of second-review points

| Point | Status |
| --- | --- |
| ADR7-S01 dedicated session | Resolved. Dedicated and Interactive Judge Session configurations are defined, with Dedicated preferred first. Registration and takeover are explicit and fenced by an owner generation. Each configuration is verified separately (ADR7-02, ADR7-14). See ADR7-T02 on enforcement |
| ADR7-S02 quiesce and busy user | Resolved. Quiesce is defined as no new dispatch, with in-flight work settled under the captured finish-or-terminate policy and no new grace period. `session_busy` is a distinct bounded deferral, and delivery milestones are separated (received, admitted, `turn_started`, `decision_applied`) |
| ADR7-S03 the 50% rule | Resolved by moving it to a separate `budget_checkpoint`, diagnostic by default and escalating only under explicit saved policy. The deterministic stagnation detectors remain |
| ADR7-S04 size | Resolved procedurally. A bounded PoC on the exact Codex version precedes the main implementation, and Stage 1 publishes separate versioned contracts |

Baseline files are byte-identical according to the resolution. The verifier was re-run in the second review and is unchanged here. `npm run docs:check` passes.

## Remaining points

### ADR7-T01 (medium): a serialized session turns the 30 s wake-up deadline into a queue-wait limit

Delivery now succeeds only on a confirmed `turn_started` within `t0 + 30,000 ms`. At the same time, at most one autonomous turn runs per registered session, and Judge turns routinely take minutes. A request created while the Judge is mid-turn on another request therefore cannot start within 30 s. It expires with `attention_delivery_timeout`, and its run quiesces into `waiting_for_user`, even though nothing failed and the Judge is actively working.

With two Fixer tasks escalating close together, the second one routinely pauses for the user. This is a structural consequence of the amendments, not an edge case.

Choose one of these in the Stage 1 contract, and test it in the PoC:

- **Inclusion in the active turn.** Count verified inclusion of the request in the active turn as meeting the wake-up deadline, using the existing "verified client interruption/update support" path. This works only where the client supports it.
- **A separate queue-wait bound.** Give a request queued behind an active Judge turn on the same session its own captured bound, distinct from transport failure and `session_busy`. The 900 s response deadline still caps the total from `t0`, so no clock resets.
- **State the behavior as intended.** Make it explicit that concurrent escalations beyond one per session pause for the user, so evaluations and pilots plan for it.

Add the case to ADR7-14 or ADR7-16: a second request arrives during a long active turn.

### ADR7-T02 (medium): make dedicated-session single-writer ownership structural

The Dedicated configuration requires "single-writer admission across every supported writing client/process", and says other clients are "observers until explicit takeover". Codex clients, however, know nothing about Deszo's owner generation. If the dedicated session is stored where the user's Codex desktop or CLI lists it, the user can open it and type. "Concurrent writing to this session is not permitted" is then a policy the client cannot see, not an enforced guarantee. The ADR rightly says a process-local mutex is insufficient, but it does not say what is sufficient.

The likely sufficient mechanism is isolation of storage, not a lock. Specify it in the PoC scope:

- **Separate client home.** The dedicated session lives in a client home or profile owned by the worker (for Codex, a separate `CODEX_HOME`), which the user's interactive clients do not load.
- **Read-only observation.** The user observes the session through Deszo's evidence or a read-only export, not through a writable client view.
- **Explicit takeover.** Takeover is a recorded export or transfer of that session into the user's profile, with owner-generation fencing, after which worker admission is refused.

If the PoC cannot isolate the session this way, the Dedicated configuration falls back to the same exclusion problem as Interactive and should be reported as such.

## Recommendation

ADR-0007 is ready for the user's acceptance decision. Record ADR7-T01 and ADR7-T02 as PoC and Stage 1 items. Both determine whether the first enabled configuration behaves usefully under more than one concurrent escalation, and whether its ownership guarantee is real.

The ADR, its reviews, resolutions and evidence files are still untracked. Commit them together.
