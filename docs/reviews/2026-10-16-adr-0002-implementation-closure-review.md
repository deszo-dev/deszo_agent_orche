# ADR-0002 implementation closure review

Date: 2026-10-16  
Subject: fixes for the [implementation follow-up review](2026-10-16-adr-0002-implementation-followup-review.md)  
Verdict: **Both follow-up findings are fixed and verified. No open implementation findings remain at fixture level.** The remaining work is live verification and the recorded gates.

## Verification

None of these checks invokes a provider or uses quota.

| Check | Result |
| --- | --- |
| `npm test` | 405 / 405 pass |
| `cargo test --locked` | 10 + 4 pass |
| `npm run runtime:bundle` run alone | The existing `dist-runtime/deszo-launch-shim.exe` survives the rebuild |

## ADR2-F02: fixed

[bundle-runtime.mjs](../../scripts/bundle-runtime.mjs) reads an existing shim before clearing `dist-runtime` and writes it back afterwards. When no shim is present it warns that the packaged app will refuse to start. I confirmed the shim survives a standalone rebundle.

## ADR2-F01: fixed for the audit bundle

`createAuditBundle` now does four things differently:

- It checks the receipt first and replays when one exists.
- It builds the bundle asynchronously: the directory and object writes are asynchronous, and the journal walk yields every 1,000 entries.
- It commits only the export row and the receipt in a short transaction.
- If a concurrent identical request committed first, it discards its own bundle and returns the committed one.

That is a correct idempotent shape. The implementer measured a 38 ms worst stall with a 64 MiB object; I did not reproduce that number.

**Residual: other synchronous work is still unmeasured.** The full-journal `store.all(…)` read at the start of the bundle, SQLite transactions in general, and journal projection on very large runs remain synchronous. Before any supervised pilot, the Stage 5 matrix should record the worst event-loop stall observed during a representative long run, as the implementation status already notes. The 15 s liveness stop is a hard stop for all supervised work, so this measurement is a precondition, not an optimization.

## Emergency credential prefetch

The bridge now fetches a supervised run's emergency credential in the background after start and on each acknowledgement. It retries for about 6 s while the supervisor arms the run. `prepare_emergency_stop` remains for an explicit refresh. This closes the reliability note from the follow-up review.

## Still open

These are correctly recorded in the [implementation status](../adr/0002-implementation-status.md):

- **Live verification has not happened:**
  - the hung-runtime path against a real supervisor, bridge and runtime together;
  - a real 15 s silence trip;
  - an installed build produced and launched.
- **Gates:**
  - the `confirmation_required` limit, which must be lifted before confirmation becomes the default;
  - the unverified client timeout matrix, so every grant is still refused;
  - live clients;
  - real-provider probes;
  - the shadcn/ui pilot, as part of Stage 5.

Nothing is committed yet.
