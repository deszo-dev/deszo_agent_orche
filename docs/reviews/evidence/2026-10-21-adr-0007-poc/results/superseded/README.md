# Superseded PoC results

These files are the first complete run of POC-04 and POC-06. They are kept unchanged for the audit trail, and they are not evidence for the ADR.

- POC-04 run 1 reported a false pass: turn B returned turn A's identifier (it was merged into the active turn), and the check read A's record as B's outcome. Fixed in `lib/experiments-turns.mjs`; the interrupt timing used an absolute clock and was negative.
- POC-06 run 1 had no check for whether a session created with no items survives a kill. Added in `lib/experiments-takeover.mjs`.
