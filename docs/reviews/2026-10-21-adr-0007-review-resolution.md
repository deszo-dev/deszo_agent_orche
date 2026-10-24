# ADR-0007 review resolution

Date: 2026-10-21  
Subject: [ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md)  
Source: [original review](2026-10-21-adr-0007-review.md), findings ADR7-R01–R05, and the user's explicit amendment request  
Disposition: Documentation amendments incorporated. ADR-0007 remains Proposed; delivery/resume, native client concurrency and mode enablement remain unimplemented and unverified.

Historical first-review resolution: the [final amendment resolution](2026-10-21-adr-0007-second-review-resolution.md) supersedes the mandatory 50% attention clause, refines ownership/exclusion by configuration, requires confirmed turn start for the delivery deadline, clarifies policy-specific quiesce and removes the fixed 10 ms implementation slice requirement. The table below records the earlier amendment and its evidence scope; it is not the current normative definition of those refined rules. Baseline sources and the verification results below are unchanged.

| Finding | Contract amendment | Required implementation evidence |
| --- | --- | --- |
| ADR7-R01 | Prefer the existing ADR-0006 persistent worker as a deterministic delivery candidate. Require exact registered external-controller session continuity, usable scoped tools, native user-turn exclusion and aggregate invocation admission/accounting. Ordinary managed provider invocations remain unable to use control tools; stripping their marker is forbidden. A separately verified client-native adapter is an alternative. | ADR7-02, ADR7-08, ADR7-11, ADR7-14 and ADR7-15. A standalone CLI reply or MCP notification cannot close these gates. |
| ADR7-R02 | Engine-derived `no_progress` policy with explicit initial thresholds: two repeated failures/unchanged work products/repeated actions, or 50% of a captured allowance without review readiness. Evaluate on commits/time thresholds and atomically before repeated repair dispatch. Persist counters across restarts and linked continuations; missing progress measures block execution. | ADR7-13 and its always-`CONTINUE` fixture, including the pre-dispatch race. These are proposed defaults, not edits to the saved Fixer workflow. |
| ADR7-R03 | Add a [baseline receipt](evidence/2026-10-21-adr-0007-baseline.json), exact-byte [original journal export](evidence/2026-10-21-adr-0007-source-journal.json), [saved-receipt index](evidence/2026-10-21-adr-0007-saved-observations.json), [historical grant](evidence/2026-10-21-adr-0007-legacy-grant.json) and [read-only reproduction script](evidence/2026-10-21-adr-0007-baseline.mjs). Pin the store/run/frontier and count definitions. | Baseline counts reproduce from retained sources; optional original-file verification checks all 21 saved observations. This closes the documentation evidence gap, not a Judge token measurement or pilot. |
| ADR7-R04 | Capture 30 s delivery and 900 s response deadlines from original request creation. A nonterminal run quiesces into existing `waiting_for_user`, with unconfirmed termination remaining explicit. A terminal handoff stays terminal; only its request expires/becomes stale. Late replies need current-state requests and authorized linked continuation. | ADR7-09, ADR7-10 and ADR7-16, including late/unknown delivery, expiry/revocation and Stop precedence. |
| ADR7-R05 | Incremental per-stream projections; proposed 1 s active-observer/package readiness, 5 s registered-destination delivery, 10 ms work slices and at-most-100 ms measured event-loop delay under a published supported-load profile. Generalize the Judge to a registered external controller session. Pin the legacy comparison to 180 s and require a 360 s healthy interval with no Judge invocation. | ADR7-01, ADR7-05 and ADR7-11, including floods, 64 MiB retained artifacts, recovery and the actual first Codex adapter. These timing bounds are not claimed as measured implementation results. |

Additional requested contracts are included: one autonomous turn at a time per registered session; deterministic priority and explicit member decisions for competing requests; persisted invocation intents/reservations and reconciliation of unknown delivery without blind model retries; and evidence treated as inert, untrusted content rather than authorization or instructions.

## Baseline method and limits

The historical export covers sequences 1–781 for run `bed47786-bb0b-4550-add6-ec83a64af8ba` in store `93322f30-eefc-4a74-8023-b805f69e2018`. A read-only live MCP identity/run snapshot still reports that store, canceled state and frontier 781. The copied source is the earlier MCP export; no claim is made that every event payload was newly fetched or compared with SQLite.

Count log events only where `metadata.type === 'attempt.log_chunk'`. The six `attempt.log_stream_closed` records remain among the other lifecycle events. Sum chunk `payload.byteLength` by stream; these are metadata totals, not a new read of all raw stdout. Count 21 distinct saved observation IDs from the initial start receipt and 20 directly saved observation files. Their retained prefix ends at sequence 602; saved receipt count proves neither model-call count nor processed/acknowledged coverage.

The exact-byte journal archive and grant, and hashed observation index, are retained under the existing evidence-file attributes. The optional original-file check verifies hashes/identities against all original local observation files. The receipt records the SQL equivalent, source paths, integrity hashes, definitions and unavailable Judge invocation/token telemetry. No credentials or raw provider stream contents are included in these copies.

## Verification scope

The read-only reproducer passed, including `--originals-root .deszo/pilots/fixer/2026-10-21/preflight-run`: 781 journal events, 689 log events, 21 distinct saved observations and a 180,000 ms historical interval. All 21 original observation file hashes/identities matched. `npm run docs:check` passed with 29 schemas, 101 Markdown files, 990 local links and no errors.

No live session resume, model call, permission/grant change, workflow revision or service update was performed. Acceptance criteria ADR7-01–ADR7-17 remain implementation/verification gates. Current ADR-0002/ADR-0006 supervision behavior remains authoritative.
