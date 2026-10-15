# Pilot rerun — resolution of RERUN-04

Date: 2026-10-14  
Rerun: [pilot rerun after the fixes](2026-10-14-pilot-rerun.md)  
Outcome: RERUN-04 is corrected in the Gate contract and implementation, with an end-to-end fixture regression and a read-only replay of the real captured run. The subsequent [live validation](2026-10-14-after-rerun04-validation.md) reached final Customer acceptance and passed all 21 independent exported-code checks, after correcting Map recovery, triage identity and the prepared pilot validator. The original rerun's "partial pass" remains its historical result; the follow-up records the later success and operator recovery.

## The defect

The Map raises specification issues in the `ISS-MAP-*` namespace, and the specification Gate let a slot resolve only issues in its own `ISS-<SLOT>-` namespace. A blocker imported from the Map, from triage or from another Gate's policy therefore had no closure path. Any reviewer claiming it made evaluate fail, and no claim left it open forever. The real run `8a34d37b…` stopped on exactly that.

## The correction

Issue ownership is now explicit ([M3/M4 issue ledger](../M3_M4_CONTRACTS.md)):

- **Owned issues:** an issue in a slot's namespace still belongs to that reviewer; only that slot may resolve it, so another reviewer's blocker stays protected.
- **Imported issues:** an issue in a namespace that no slot of the current policy owns is imported. A **live** slot may resolve it when its review scope covers every requirement the issue cites; scope means the slot's `scopeRefs`, or its view's normative sections, with their transitive dependencies. An imported issue citing no requirement needs a full view without `scopeRefs`.
- **Ledger:** the issue keeps its ID, message and evidence through the transition.
- **Plan and enforcement:** prepare publishes each slot's authorized IDs as `resolvableIssueIds` in the review plan (additive in [gate.schema.json](../schemas/gate.schema.json)). Evaluate recomputes the authorization from the subject bundle and does not trust the plan input.
- **Prompts:** the review prompts of every example now tell reviewers to resolve the issues listed in their slot's `resolvableIssueIds` that the revision fixes, and never another reviewer's issue.

Code: `issueOwner`, `mayResolve`, `prepare` and `evaluate` in [gate.mjs](../../runtime/core/gate.mjs).

## Evidence

| Check | Result |
| --- | --- |
| End-to-end regression (`reference.test.mjs`, "RERUN-04") | Exactly the path the rerun required. The executor asks for a specification revision, and the Map returns an `ISS-MAP-*` blocker. The revised bundle is reviewed with it open, and the Customer slot is authorized because its public scope covers the cited requirement. The blocker is closed by a live review, the Gate opens, and the next Map runs. The delivery is accepted with a pinned final certificate |
| Authorization boundaries (`pilot.test.mjs`) | Another reviewer's own blocker is refused. An imported issue citing an internal contract cannot be closed by the public Customer view but can by a full view. A narrowed `scopeRefs` covers only its closure. An uncited import needs an unrestricted full view |
| Real captured run, read-only ([check script](../../scripts/pilot-issue-resolution-check.mjs), [result](evidence/2026-10-14-rerun04-fix-check.json)) | Replaying the actual recorded decisions of `delivery/2/specification/1` no longer fails. Antigravity's testability review legitimately closes `ISS-MAP-E52E72D8BB` (it cites `CONTRACT-AUTH`, covered by the full view). The Gate correctly returns `REVISION_REQUIRED` only because Claude's readiness review raised a genuine new blocker. Counterfactually, the Customer slot is refused (public view, internal contract), while readiness or testability closing it yields OPEN |
| `npm test` | 344 passed, 0 failed |
| `npm run docs:check` | Pass |

The rerun's original [probe](../../scripts/pilot-issue-resolution-probe.mjs) asserts the old defect, so it no longer reproduces it. It and its [recorded result](evidence/2026-10-14-rerun-issue-resolution.json) are kept unchanged as the historical record. The new check script is its post-fix counterpart over the same store.

## Completed follow-up validation

The authorized production follow-up completed on a fresh root with the same three simple models:

```powershell
node --disable-warning=ExperimentalWarning scripts/pilot.mjs --root .deszo/pilots/after-rerun04-recovery-fix --minutes 60
```

Run `84ad4815-6772-4e22-9ca6-519a08ce1b6f` ended as `succeeded`, with final certificate `CERT-52DB265D719B`. All 28 exported tests and 21 independent business checks pass. The successful run needed one controller restart of its Specification Loop and did not traverse a Map-origin specification revision; that branch's evidence remains the fixture regression and read-only replay above. All attempts and their subscription invocations are retained in the follow-up report. Use a new root when repeating the command to preserve this evidence.

The rerun's practical limits still apply: no large coding projects, multi-day load, future CLI updates or clean-machine installation.
