# P6-BUILD-GENUINE-E2E — Genuine P5 Acceptance, Automatic P6 Activation, Two Protected Repairs

**Project:** Deszo Agent Orchestrator
**Stage:** P6-BUILD-GENUINE-E2E
**Architecture:** ADR-0010 — Minimal Autonomous Engine Self-Update
**Dates:** 2026-11-03 (first attempt, blocked) and 2026-11-04 (contract amendment and final verification), Europe/Moscow
**Contract amendment:** [2026-11-04-p6-genuine-contract-amendment.md](2026-11-04-p6-genuine-contract-amendment.md) (§7 is the review disposition and governs)
**Prerequisite:** `P6-BUILD-UNBLOCK VERIFIED — READY FOR GENUINE P5 AUTONOMOUS E2E` ([unblock report](2026-11-03-p6-build-unblock.md))

## 1. Final verdict

**`P6-BUILD GENUINE E2E VERIFIED WITH LIMITATIONS`**

- **A → B → C, genuine and automatic.** Engine A admits a real Parent incident. A real Repair (Developer edit plan, real Gate with the causal reproducer and the protected authority regression, mandatory Judge, P2 acceptance) produces a genuine immutable handoff. The production trigger builds, attests and switches to B with no Owner call. B then runs its own protected Repair, on a different enrolled slot, from the same published Parent, and produces a second genuine handoff. The production trigger switches to C, and C validates its own P5 continuation. Packaged test `P6-BUILD-GENUINE-E2E` **passed** on the final source (run 20, §5).
- **Exhaustion fails closed.** A two-slot pool activates B, then refuses C's successor with `p6_successor_workspace_exhausted` before any operation intent, build or Host staging. B stays selected. Packaged test `P6-BUILD-GENUINE-E2E-EXHAUSTION` **passed** on the same source.
- **Limitations** (§9): the Developer and Judge are deterministic provider responses, not a live model; the Parent worker is a fixture; M1 (Host commit-window race) remains open; the full `npm test` regression was not run. The final review round (read-only) found two gaps, both fixed and verified by run 20; the final delta itself has one review pass, not a second.

## 2. Repository state

| Item | Value |
| --- | --- |
| Branch | `codex/adr-0003-0005-completion` |
| HEAD | `1f54c47fe265c6b47bf36695be56214056fc3af1` (unchanged) |
| Commits made | none; no reset, clean, stash, rebase, merge or push |
| Working tree | 110 entries from earlier stages plus this stage's changes (uncommitted) |
| Source snapshot (prior method: sorted `git ls-files --cached --others --exclude-standard`, excluding `.deszo/` and this report, `path` NUL SHA-256 of bytes, newline) | **838 paths, `f52609d60bfb1ef08cf66c54db99971cb0c7cd36d5b7ff29789a133e7c1be223`** |

This stage edited no file under `lifecycle-host/` or `src-tauri/`. The Rust Host and Tauri Shell are unchanged by this stage. The Host and Shell sources show only uncommitted changes from earlier stages.

## 3. What changed in this stage

### 3.1 Contract amendment (owner-approved, 2026-11-03)

1. **Root-bound Parent.** Parent publications bind the immutable root profile identity (`enrolledParentProfile` = `enrollment.rootProfile ?? enrollment.profile`). A P6 successor's effective profile replaces only the effective `profile`. `rootProfile` is set only by `resolveP6Continuation` and is refused on any root file.
2. **Pre-enrolled slot pool.** The root enrollment carries `workspacePool` (1 to 8 entries, ordered, first entry equal to `workspace`). Entries are distinct and non-overlapping by real directory. Installation refuses an entry that is not the registered workspace at its canonical root, is not empty, differs from the Host-attested identity, is not at its real path, or overlaps any other registered workspace.
3. **Deterministic successor slot.** The successor takes the pool entry after the one its release runs on (`nextP5WorkspaceSlot`). The continuation requires exactly that entry (`exactSlot`). Exhaustion refuses before the operation intent. The consumer verifies the slot's native identity and emptiness before the build.
4. **Single use, no deletion.** A P5 Repair claims its slot (`p5_workspace_claimed` on a second claim). An enrolled slot, or a workspace whose real directory overlaps one, is reserved against ordinary Runs, Parent Runs and generic P2 Repairs (`p5_workspace_reserved`, `p5_workspace_enrolled`). The reservation reads the pool from the loaded enrollment, or from the installed file when startup refused the enrollment. Nothing is deleted or recycled (P5-08).
5. **Gate.** The Repair node's verification policy is checked against the root policy (`enrolledRootPolicyRef`). The publication, which is immutable, still binds the enrolled policy. Verification runs against the effective policy, which differs from the root only in the harness closure digest.

Design review and implementation review, with dispositions, are in the amendment §7. Findings were checked against the code before any change. One finding (a reservation that counted claims) was a regression I had introduced, and it is fixed.

### 3.2 Production files changed in this stage

`runtime/core/protectedSelfRepair.mjs`, `p6Continuation.mjs`, `p6Successor.mjs`, `p6Consumer.mjs`, `p5Gate.mjs`, `p5Provisioning.mjs`, `linkedRepair.mjs`, `engine.mjs` (the amendment hunks, plus the `[P6]` activation log now carries the error code), `workflowJudge.mjs` (one Parent-profile equality removed; the Parent is checked at admission and on the candidate path), and `docs/schemas/protected-self-repair.schema.json` (`enrollmentWorkspace`, `workspacePool`, `rootProfile`).

### 3.3 Test files

- `runtime/tests/p6-genuine-support.mjs` (new): two incidents in one Engine-core module, the generic protected reproducer, the Parent worker's probe, Developer plans, protected checks.
- `runtime/tests/p6-genuine-e2e.test.mjs` (new): the chain (three slots) and the exhaustion variant (two slots), sharing one parameterised function. The chain also asserts C's continuation, that the root enrollment file is byte-identical, that the enrolled origin's `main` is unchanged, and that a Parent run aimed at the claimed slot is refused.
- `runtime/tests/p5-workspace-pool.test.mjs` (new): ten unit tests for the pool, root-binding, overlap refusal, rootProfile refusal and next-slot selection.
- `runtime/tests/p6-g0-support.mjs`: `startShellHost` accepts an `env` pass-through only.

## 4. Real installation

- Stable Shell `shell-g0`, Engine A `engine-a` (trusted packager, `testFaultHooks`), real Rust Host, real SQLite Store, real Git source with one enrolled bare origin (`fetchRefs: refs/heads/main`, publication disabled).
- Enrollment `2c72d2f3-ce9b-421f-ab9c-1154bec07553`: root verification policy with the causal reproducer and the authority regression; three single-use slots (`p5-slot-1..3`), each read through the Host identity reader at setup; one published Repair workflow; one published Parent workflow pinning `p5-slot-1`; the complete enrollment installed once.
- Engine A source commit `1616cc423675873a706ac4f789e94ab160860bfb`. Admission on Engine A: `enabled: true`, `reasons: []`.

## 5. Evidence (run 20, final source)

Full evidence: [2026-11-04-p6-genuine-e2e-evidence.json](evidence/2026-11-04-p6-genuine-e2e-evidence.json) and [2026-11-04-p6-genuine-e2e-exhaustion-evidence.json](evidence/2026-11-04-p6-genuine-e2e-exhaustion-evidence.json).

| Evidence | Value |
| --- | --- |
| Enrolled pool | `p5-slot-1`, `p5-slot-2`, `p5-slot-3` |
| Repair 1 (A's Parent) | run `a283d776-4f92-4429-b1a0-b20d13cbd774`, slot `p5-slot-1`, `succeeded`; handoff at journal sequence 91 |
| Repair 2 (B's Parent) | run `1b9d138b-42a1-4ecc-a373-0b0c8516b15b`, slot `p5-slot-2`, `succeeded` |
| Claimed slot refused to an ordinary Run | `409 p5_workspace_reserved` (slot `p5-slot-1`) |
| A → B activation | operation `775c9cf8-0523-42b3-9341-fc273aa3a0a1`; B `engine-5a95292005e1`; package sha256 `afba65da40b5809b…`; `fallbackAttempted: false` |
| A → B Host sequence | `engine_staged` (…950990) → `engine_switch_accepted` (…959661) → `engine_switch_committed` (…977782) → `engine_switch_verified` (…985937) → `engine_ready` (…985941) |
| B → C activation | operation `50f82644-3276-4420-bd51-4b4e3c477678`; C `engine-c2e4677abba9`; package sha256 `838b9f68f9ff5796…`; `fallbackAttempted: false` |
| B → C Host sequence | `engine_staged` (…257583) → `engine_switch_accepted` (…266089) → `engine_switch_committed` (…283508) → `engine_switch_verified` (…292317) → `engine_ready` (…292320) |
| C continuation | `release.buildId = engine-c2e4677abba9`, committed operation as above, `enabled: true`, `reasons: []` |
| Root enrollment file | sha256 `977e9670cff24f816eb9d253c57305e06025699289a85af626bb5be31449e938`, unchanged across the chain (asserted) |
| Enrolled origin `refs/heads/main` | `1616cc423675873a706ac4f789e94ab160860bfb` (the release commit), unchanged (asserted); no push |

Exhaustion variant (run 20, pool of two): Repair 1 `c03b982d-98f5-49b5-a5a9-51c28cb2ecb2` on `p5-slot-1`, Repair 2 `8d6d36c9-f3c7-4736-b552-ef9d7f31eba1` on `p5-slot-2`, both `succeeded`. B activated (`stagedEvents: 1`, the B switch only). C's successor was refused: `[P6] Activation background task failed for 8d6d36c9-… (p6_successor_workspace_exhausted): … no operation, build or Host staging was started.` B remains the Host-selected release.

Owner calls: after the initial setup (publications, enrollment install, Host identity reads), the test made only Parent-run starts (`POST /api/v2/runs`, the incident), read-only status reads (`GET /api/v2/installation/source-release`), and refused ordinary-run attempts (the claimed slot, `409 p5_workspace_reserved`). It made no publication, enrollment, approval, or activation call between A → B and B → C. This is by inspection of the test's call sites; the test does not record the calls mechanically.

## 6. Independent reviews

| Review | Result | Disposition |
| --- | --- | --- |
| Design (fresh context, read-only) | APPROVE WITH CHANGES; 11 findings (2 Critical, 4 High, 3 Medium, 2 Low) | All applied; see amendment §7 |
| Implementation (fresh context, read-only) | ACCEPT WITH CHANGES; one High (P5 admission could enter a reserved slot), three Medium, three Low | Applied: Parent and ordinary runs refused from enrolled slots; exhaustion before the operation intent; node IDs bound; exact successor slot; generic and ordinary judge-path refusals |
| Focused re-review of the delta | APPROVE WITH CHANGES; one regression (a generic P2 Repair reserved its workspace permanently), one open alias bypass | Applied: the reservation no longer counts claims; overlap is by resolved real path; installation refuses overlapping workspaces |
| Final read-only review of the reservation and installer hunks | NEEDS CHANGE; two fail-open gaps: (1) a refused enrollment left the slots unreserved, so an ordinary run could enter a slot; (2) an enrolled root that was not a real path (junction or alias) could hide a slot from the overlap checks | Applied: the reservation reads the pool from the installed file when the enrollment is refused, and fails closed when that file is unreadable; the installer requires each enrolled root to be its real path. Verified by run 20 (both variants). **These two fixes have not had a second independent review.** |

## 7. Failure history (honest account)

The packaged chain was run 20 times in this stage. The early failures were harness defects, found from retained journals: a missing parent workspace directory; a stale Host descriptor; a Gate subject-entrypoint error in my reproducer; a dynamic import the Gate refuses; a default Developer model that writes a fixed fix; a probe bound to the package root instead of the `p5/` payload; a fail-fast that treated an approved Repair's `failedNodeRetry: never` suspension as a refusal. Under the amendment, the failures were real but contract-level: the reservation counting claims; the Gate comparing a published Repair's policy with the effective enrollment (now the root policy, by design); the Parent's own incident error treated as a Repair refusal (harness). None of the early failures was a production defect in the original P5 or P6 code.

## 8. Operational notes

- Pool capacity: a planned chain of N Repairs needs N + 1 enrolled slots. The release after the last Repair still needs a slot for its successor to be continuation-eligible. A → B → C needs three slots. A two-slot pool activates B and refuses C's successor fail-closed (proven by the exhaustion variant).
- Reader compatibility: `minimumReaderCapability` stays `protected-self-repair-v1`. The enrollment schema is `additionalProperties: false`, so a reader that predates these fields refuses the enrollment rather than misreading it. This is the chosen fail-closed behavior (amendment F10).
- A Parent waiting for recovery holds its workspace; a second incident runs in its own Parent workspace.
- Single-slot installations (no `workspacePool`) behave as the pool of one. A successor for such an installation is refused as exhausted.

## 9. Limitations and outstanding items

1. **Controlled provider responses.** The Developer edits and the Judge decisions are deterministic fixture responses, and the Parent worker is a fixture CLI. The Gate, P3, P4, P2, mandatory Judge acceptance, P5 handoff and P6 build, switch and continuation are production code. This is not a live-model test.
2. **M1 (Host commit-window race): open.** Not observed in these runs. It remains a separate native release gate, to be fixed with its own failing test.
3. **Full regression not run.** The focused suites pass: `protected-self-repair`, `p6-build-unit`, `p5-desktop-layout`, `p5-workspace-pool` (45/45). The packaged genuine test passes (2/2). The full `npm test` regression is the final release gate.
4. **Not exercised by a packaged test:** the generic P2 route refusal, and the reservation of a slot when the enrollment is refused at startup. The first is covered by code review; the second is covered by code review and by the unit-level reasoning in §3.1(4), not by a run.
5. **C's slot is not separately recorded.** C's successor selected `p5-slot-3` (a successful build and switch require the membership and exactness checks). The evidence does not extract C's profile artifact.
6. **The final two fixes have one review pass.** The enrollment-refused reservation and the real-path requirement were reviewed once, read-only, and then verified by run 20. They have not been independently re-reviewed.
7. **Build receipt artifacts.** The P6BuildReceipt artifact identifiers and the two-build reproduction digests are not extracted into the evidence record.
8. **Single-use slots are bounded.** P5-08 forbids automatic deletion or recycling. Unlimited continuation needs a separate native cleanup decision with its own security review.

## 10. Recommendation

Commit the amendment and the harness as one reviewed change, after the full `npm test` regression and the M1 native fix are scheduled. The decision to commit is the owner's.
