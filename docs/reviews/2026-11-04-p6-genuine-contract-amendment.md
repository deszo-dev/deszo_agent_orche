# P6 Genuine E2E — Contract Amendment: Root-Bound Parent and Pre-Enrolled Slot Pool

**Date:** 2026-11-04 (Europe/Moscow)
**Stage:** P6-BUILD-GENUINE-E2E (follow-on to [the blocked report](2026-11-03-p6-build-genuine-e2e.md))
**Status:** proposed for independent design review; not yet implemented
**Owner decisions (2026-11-03):**
1. Bind immutable Parent publications to the original P5 root profile identity. Accept a successor effective profile only through the existing Host-attested P6 continuation chain. Preserve non-release Owner policy and publication immutability. No per-release Owner action and no new authorization mechanism.
2. Pre-enroll an ordered pool of independently registered single-use slots at initial Owner enrollment. Each protected Repair claims one unused slot through the existing P5 ownership and native identity checks. Preserve P5-08: no automatic recursive deletion, recycling or implicit reuse. Exhaustion fails closed. No Host redesign, no deletion capability.

## 1. Problem (observed, run 9)

- `POST /api/v2/runs` for the second Parent incident under B returned `409 p5_profile_mismatch` (`runtime/core/engine.mjs:443`). The check compares the Parent publication's `selfRepair` reference with `enrollment.profile`. After a P6 update the effective enrollment's `profile` is the successor profile, so the immutable publication (bound to A's profile) can never match.
- The single-use slot blocks reuse: `retention` records `cleanupDeferred: true` (`runtime/core/linkedRepair.mjs:443`), nothing consumes it, and `protectedSelfRepairWorkspaceReserved` (`linkedRepair.mjs:65`) is permanent. P5-08 forbids automatic release.

## 2. Amendment A — root-bound Parent

Define the enrolled Parent profile identity:

`enrolledParentProfile(enrollment) = enrollment.rootProfile ?? enrollment.profile`

- **Root enrollment** (the immutable file): `rootProfile` is absent; the identity is `profile`. Unchanged for every existing installation.
- **Effective enrollment** (derived by `resolveP6Continuation`): `rootProfile` is set to the root's `profile` reference (a new optional enrollment field). `profile` remains the successor profile, validated as today.

Every comparison that concerns the Parent publication, the Parent's captured authorization, or the P2 authorization uses `enrolledParentProfile`:

| Site | Compares | Change |
| --- | --- | --- |
| `engine.mjs:441` | publication `selfRepair` vs enrollment profile | use `enrolledParentProfile` |
| `engine.mjs:458` | Parent admission `profile` | pass `enrolledParentProfile` |
| `engine.mjs:493` | `profile.selfRepair` vs enrollment profile | use `enrolledParentProfile` |
| `engine.mjs:759` | P2 authorization `selfRepair` vs enrollment profile | use `enrolledParentProfile` |
| `protectedSelfRepair.mjs:1201` | `authorization.selfRepairProfile` | use `enrolledParentProfile` |
| `protectedSelfRepair.mjs:2295` | P2 `selfRepairProfile` | use `enrolledParentProfile` |
| `p5Gate.mjs:660` | authorization `selfRepairProfile` | use `enrolledParentProfile` |

Sites that concern the **effective** profile (source binding, candidate `selfRepairProfile` at `protectedSelfRepair.mjs:1455` and `2262`, Gate profile read at `p5Gate.mjs:664`, `engine.mjs:503, 515, 564`) keep `enrollment.profile`, because they describe the release that is actually running.

Successor preparation and continuation:

- `runtime/core/p6Successor.mjs` already reads the enrollment's current profile. Its successor `workspace` changes per §3.
- `runtime/core/p6Continuation.mjs:301-308` (non-release check) keeps every check except `workspace`, which moves to §3. Publication identity (`repairPublication`, `parentPublication`) is still required to match the root.
- `runtime/core/p6GitObjectSource.mjs:91, 101` and `runtime/core/p6Reconstruction.mjs:148` compare `enrollment.profile` with the successor/build record. They keep effective semantics and are not Parent-binding sites.

Invariants: the root file stays byte-identical; the publication stays immutable; the successor profile is accepted only if it is the one the Host-attested continuation receipt names (`resolveP6Continuation`), so no profile is accepted from a model, a route or an Owner call.

## 3. Amendment B — pre-enrolled single-use slot pool

Root enrollment gains:

- `workspacePool`: ordered array of enrollment-form workspace entries (`workspaceId`, `canonicalRoot`, `allocationId`, `nativeIdentity`), 1 to 8 entries, pairwise distinct on `workspaceId`, `allocationId` and `canonicalRoot`.
- Invariant: `workspace` equals `workspacePool[0]`. When `workspacePool` is absent, the pool is `[workspace]`, so existing single-slot installations are unchanged.

Installation (`installP5Enrollment`, `runtime/core/p5Provisioning.mjs`): every pool entry is verified against the Host-attested native identity of its canonical root, and each slot must be an empty, dedicated, registered workspace.

Selection (`runtime/core/p6Successor.mjs`): the successor profile's `workspace` is the first pool entry with no P2 link. A link "claims" a slot when `run_links.repair_workspace_id` names it. Selection is deterministic at build time from durable state, and the continuation receipt records the exact selected entry, so the continuation never recomputes it.

Exhaustion: if every pool entry is claimed, the successor is refused with `p6_successor_workspace_exhausted` before any staging. No half activation, no reuse.

Effective enrollment: `workspace` equals the successor profile's selected entry (enrollment form), so all downstream checks (`workspace_slot` admission, Gate workspace binding, retention, handoff and source-binding workspace references) keep reading `enrollment.workspace` unchanged.

Repair workspace (`runtime/core/linkedRepair.mjs:916`, Parent admission `:793`): for a P5 profile, the Repair workspace is the effective `enrollment.workspace`, not `profile.repairWorkspaceId`. The publication's pinned `repairWorkspaceId` must be a member of the enrolled root pool (`enrollment.workspacePool` or `[workspace]`). The authorization records the resolved workspace, so `engine.mjs:761` continues to compare equal values.

Claim refusal: a P5 Repair admission for a workspace that already has a P2 link is refused with `p5_workspace_claimed`. The existing reservation predicate still blocks ordinary Runs.

Capacity: a planned chain of N Repairs needs N+1 pool entries. The release after the last planned Repair still needs an enrolled slot, so that it is continuation-eligible. For A → B → C (two Repairs) the pool has three entries. This is bounded capacity; unlimited continuation needs a separate native cleanup decision (P5-08).

## 4. What does not change

- No Owner action between releases. The Parent publication, the Repair publication, the verification policy's checks and bounds, scope, budgets, node IDs and `failedNodeRetry` are root-bound and immutable.
- No Host or Shell change. No deletion or recycling. No new authorization mechanism. No SQLite migration.
- P5 Judge authority, Gate, causal reproduction and the mandatory Judge are unchanged.
- `failedNodeRetry: never` still suspends a Parent whose failed node is not authorized for retry. An approved Repair's handoff still exists; this is the existing P2 behavior.

## 5. Acceptance evidence required

1. Unit: pool validation (distinct entries, native identity, `workspace === workspacePool[0]`); successor selection (first unclaimed, deterministic); exhaustion refused before staging; Parent binding accepts the root identity and refuses a foreign one; `p5_workspace_claimed` refusal; continuation non-release check accepts a pool member only.
2. Packaged genuine E2E, same published Parent throughout: Parent-1 → Repair-1 on slot 0 → automatic B on slot 1 → Parent-2 (same publication) → Repair-2 on slot 1 → automatic C on slot 2. Assert the two Repairs select different valid slots without an Owner call between A → B and B → C.
3. Negative: a pool of two entries with two Repairs must refuse the successor of the second Repair with `p6_successor_workspace_exhausted` and leave the Host selector on B.
4. Independent design review of this document and the code paths in §2–§3 before implementation is merged into the final report.

## 6. Open questions for the reviewer

- Is the claim rule "no P2 link names the slot" sufficient, or must the claim also include the Repair's terminal state?
- Is the root-profile identity the right reference for the Parent publication, or should the publication bind the enrollment's `repairPublication`-style identity?
- Are there other `profile.repairWorkspaceId` readers that assume a single slot?

## 7. Independent review disposition (2026-11-04)

An independent, read-only, fresh-context review returned **APPROVE WITH CHANGES**. Its findings were checked against the code and applied as follows. Where this section differs from §2–§3, this section governs.

- **F1 (Critical, applied). The P2 authorization's `selfRepairProfile` is the effective release profile.** The judge path (`linkedRepair.mjs`) records `p5Admission.enrollment.profile`, not the Parent-pinned root reference, because the candidate copies that field (`engine.mjs`, `candidateAuthorization`). Parent identity is checked only through the captured publication profile (`authorization.profile.selfRepair`) against `enrolledParentProfile`. The §2 rows for `protectedSelfRepair.mjs:1201`, `protectedSelfRepair.mjs:2295` and `p5Gate.mjs:660` are withdrawn: they keep comparing the effective `enrollment.profile`, and the Gate also compares `sha256`.
- **F2 (Critical, applied). The admission `profile` stays effective.** The §2 row for `engine.mjs:458` is withdrawn: that value becomes `sourceBinding.profile`, which must equal the effective profile.
- **F3 (High). `p6Reconstruction.mjs:148` and `protectedSelfRepair.mjs` candidate checks** compare effective fields. They are correct once F1 holds.
- **F4 (High, applied). One claim predicate, state-independent.** `SELECT 1 FROM run_links WHERE repair_workspace_id = ?` with no contract, state or authorization filter (`protectedSelfRepairWorkspaceClaimed`). It drives the P5 Repair refusal `p5_workspace_claimed` and, with pool membership, the ordinary-run reservation. Generic P2 routes refuse enrolled pool slots (`p5_workspace_enrolled`). Claims do not release on terminal state: a failed or accepted Repair keeps its retained content, and releasing it would be implicit reuse (P5-08).
- **F5 (High, applied). `rootProfile` is refused on any root file** (`assertP5RootEnrollment`, at install and at startup). Only `resolveP6Continuation` derives it.
- **F6 (High, applied). Slot selection is deterministic, not claim-based.** The successor's slot is the pool entry after the one the handoff's effective enrollment runs on (`nextP5WorkspaceSlot`). It does not depend on live claims, so a replayed build or a rebuild after later Repairs names the same slot. The continuation (which runs at every start) checks membership only. The claim is refused at P5 Repair admission.
- **F7 (High, partly applied). Pool verification.** Install refuses an entry that is not registered at its canonical root, is not empty, or differs from the Host-attested native identity when the caller supplies `hostWorkspaceIdentities`. Before any successor build or Host staging, the consumer verifies the next slot's native identity and emptiness through the Host (`p6Consumer.mjs`). Residual: the installer is synchronous and reads no Host identity itself; its identities come from the Owner setup's Host reader.
- **F8 (Medium, applied). Pool roots must not overlap or nest** (`workspaceRootsOverlap`). The Parent root overlap is enforced at Repair admission by `linkedRepairWorkspaceIssue`.
- **F9 (Medium, applied). Refusal before any write.** Selection and exhaustion are evaluated before the successor's first Store artifact, and the consumer refuses before packaging.
- **F10 (Medium, decision). Compatibility.** `minimumReaderCapability` stays `protected-self-repair-v1`. The enrollment schema is `additionalProperties: false`, so an older reader refuses an enrollment with these fields rather than misreading it (fail closed). No receipt field is added: `successorP5Profile` already binds the selected slot.
- **F11 (Low, applied).** The Gate compares `artifactId` and `sha256`. The predecessor local in `p6Successor.mjs` is renamed `predecessorProfile`. The unused workspace field on the link object is removed.

**Pool size.** A → B → C has two Repairs (A's and B's). The release after the last Repair (C) still needs an enrolled slot for its successor to be continuation-eligible. So three entries are needed. A pool of two activates B and then refuses C's successor with `p6_successor_workspace_exhausted` before any staging. That is the negative case to prove.

**Open questions, answered.** Root identity: correct. A publication can pin only a profile reference, and the root reference is the only one that does not change between releases. The claim rule is state-independent (F4). The single-slot readers that the reviewer listed are all pool-based now.
