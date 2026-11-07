# 11. Consistency review

- **Date:** 2026-11-06
- **Scope:** documents 01-10 of this folder and the proposed [ADR-0012](../../adr/0012-rust-first-backend-and-engine-lifecycle.md).
- **Method:** one pass by the author across all documents: every cross-reference of the form "NN §X" was checked mechanically against the target headings; each message kind, record kind, open decision and prerequisite was traced through every document that names it; claims about current behavior were rechecked in the source where they were not already cited.
- **Not done:** the independent fresh-context architecture and security reviews of the brief's section 26. This pass is not a substitute for them (§4).

## 1. Findings and fixes

| ID | Finding | Fix |
|---|---|---|
| C-1 | 02 §5 listed `rusqlite` for a Host acceptance index, while 05 §3 specifies a database-free protected store | 02 §5 corrected: no database in the Host |
| C-2 | 03 §4 omitted `Repair::ReportInvalidation`, which 04 §2 and 05 §5 define | Added, with its narrowing-only rule |
| C-3 | 02 §1 rule 3 said no bearer capability authorizes anything, which contradicts the Owner Token on the public API | Scoped to Host-child channels; Owner Token reference added |
| C-4 | The snapshot export job (04 §3.1) runs Git, but the process table in 02 §2 listed only Cargo and test binaries | Process table corrected |
| C-5 | 08 §2 relied on an "Admission panic does not stop lifecycle functions" rule that 02 §3 did not state | Rule added to 02 §3 with its test |
| C-6 | 01 §2 pointed to 02 §5 for the Shell supervisor and launch shim; the content is in 02 §2 | Reference corrected |
| C-7 | 06 §4 claimed the current Host "does not advertise the P6 capability" to the shipped Node release; no such switch exists in the source | Restated as the ADR-0011 release block, which is the real restriction |
| C-8 | 06 §6 described UI use of `shared/*.mjs` as type-only; the UI imports the modules directly (`src/model.ts:3-4`, `src/Replay.tsx:4`) | Corrected; effort-policy drift test added |
| C-9 | Three of the eight required diagrams were missing (trust boundaries, build and attestation, Store ownership) | Added to 03 §3, 04 §7, 05 §3 |
| C-10 | The containment profile for network-using Engine operations (Owner-requested branch publication) was unspecified | Added to 09 §3 as a technical question tied to PR-2 |
| C-11 | 02 §8 asserted that custody jobs end with the Host | Verified as current behavior (`lifecycle-host/src/custody.rs:1192-1204`, kill-on-close Job, `host_lost` on restart); citation added |

## 2. Earlier security findings as design requirements

Each finding recorded in 01 §4 is treated as a requirement, not re-tested.

| Recorded finding | Requirement it creates | Where the design meets it | Enforcement depends on |
|---|---|---|---|
| Engine code staged and switched the Host without P5 | No stage or switch verb reachable from repairable code | 03 §4, 04 §7, 07 §5 | Protocol design (no prerequisite) |
| Bridge allowlist bypassed by a pass-through | No generic pass-through; a closed message enum | 05 §5 | Protocol design |
| One capability for every command family | Principal by channel, not by bearer secret | 02 §1, 05 §5 | PR-5 |
| Same-user children could reach the Store and the Owner Token | Candidate- and provider-controlled processes contained; Owner Token outside every grant | 03 §1, 05 §7 | PR-1, PR-2 |
| Same-user processes could reach Host secrets | No authority-bearing secret shared with children; contained processes denied Host access | 02 §1, 03 §5 | PR-1 |
| Reflection, `vm`, `require(esm)` reach protected modules | Authority must not live in the repairable process at all | 02 §3, 04 | None (structural) |
| Consumer reads acceptance from the caller's Store | Acceptance evidence created and stored by trusted code only | 04 §1, 05 §3 | PR-1 (access denial to Host directory) |
| AppContainer denials shown; ESM, children and cross-container not shown | Rust Engine must be shown contained, with children and cross-container cases | 09 PR-1 | PR-1 |
| Developer confinement not verified (R3) | Provider runs contained or P5 admission closed | 03 §7, 04 §2.1, OD-1 | PR-2 |
| Live-Store preflight unsafe | Guarded disposable copy kept; now also enforced by grant | 04 §7 | Existing G0 |

## 3. Unresolved architectural decisions

The design has no contradiction left between its documents after §1. What remains open is listed in [09](09-open-decisions.md) and summarized here:

- **Enforcement concentration.** The whole boundary rests on containment (PR-1, PR-2, PR-3, PR-5). If PR-1 fails on the target platform, the design does not degrade gracefully: the Engine would again be in the Host's trust domain. This is stated as a blocking prerequisite rather than hidden behind a fallback.
- **Provider containment (OD-1).** Containing ordinary provider runs changes the current Full Access default and adds grants on the Owner's project folders. Not containing them keeps P5 admission closed. There is no option that keeps both today's default and autonomous Self-Repair.
- **Judge semantics.** The Host proves which Judge ran on which dossier, not that its judgement is right (04 §5.3 and §11 in the revised version). Accepted as today; the damage bound is containment of the accepted Engine.
- **Build target and reproducibility (OD-8, PR-4).** MSVC determinism across directories is unproven.
- **Cutover (OD-2), legacy Control Host (OD-5), manual earlier-build selection (OD-4), external token (OD-6), interim release (OD-7), platform order (OD-3).**

## 4. Independent review status

The brief requires at least two fresh-context read-only reviews (architecture and security) with source references and counterexamples, and the design acceptance checklist includes "Independent reviews are complete". They were not run in this pass. Until they are, the verdict in the [folder index](README.md) is a proposal by the author, and ADR-0012 stays Proposed. Reviewer disagreements, when the reviews run, are recorded in a new section of this document.

## 5. Remediation round (2026-11-06)

The independent architecture and security reviews returned BLOCKED on the first version. Their findings, verification against source, corrections and status are consolidated in [12](12-finding-register.md); the re-review results and the verdict are recorded there. This document keeps the first-version pass for history.
