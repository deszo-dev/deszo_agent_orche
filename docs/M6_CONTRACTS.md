# M6 Contracts — Selective Revisions

Version: 1.0  
Status: implemented contract package for M6  
Updated: 2026-10-13

This is the normative home for carrying verified review approvals and Map task selections across specification revisions, the per-reviewer Route wiring, generation history and Map Replay. It extends the [M5 contracts](M5_CONTRACTS.md). Targets and motivation stay in [Pipeline execution](PIPELINE_EXECUTION.md#selective-reviews-at-m6) and [Implementation Map](IMPLEMENTATION_MAP.md#revisions-and-carry-forward). Nothing is carried silently: every carry is an explicit, verified engine record, and anything unknown fails closed to a live review or a fresh task.

## Contract package

| Artifact | Change |
| --- | --- |
| Workflow | Capability `revisions-v1` (requires `delivery-v1`). Gate prepare `carry: true` (prepare only) adds input `prior` and one output `<slot>-need` per slot; policy slots may narrow their scope with `scopeRefs`; Map `carryAcrossRevisions: true`. Semantic codes `capability.revisions`; `gate.review-source` additionally accepts a selected Merge joining exactly one live Agent `json` answer; `gate.slot` limits carry slot IDs to 59 characters. |
| Gate records | [gate.schema.json](schemas/gate.schema.json): `reviewNeed`, `reviewCarryRequest`, `reviewCarry`; plan slots gain `scopeHash`, `status`, `needsReview`, `priorReview`, `reviewerFingerprint`; `reviewRecord` gains `scopeHash`, `policyFingerprint`, `reviewerFingerprint`. |
| Map records | [map.schema.json](schemas/map.schema.json): `taskCarry`, `history`; MapState tasks gain `fingerprint`; the summary gains `carries`; navigator tasks gain `fingerprint`, `carriedFrom`, `results`, and the navigator gains `runId`, `priorExecutionId`, `crossRevision`. |
| Journal v2 | Additive `gate.review_carried`; `map.record_created.kind` adds `TaskCarry`. |
| API v2 | `GET /api/v2/runs/{runId}/maps/{mapInstanceId}/executions` → `mapHistory`; `GET /api/v2/map-executions/{executionId}` → `mapNavigator` of that (possibly historical) execution. |
| Storage | [Migration 5](storage/m5.sql): `pipeline_records` accepts `ReviewCarry` and `TaskCarry`. |
| Fixtures and example | `m6-*` manifest and invalid cases, [payloads](fixtures/valid/m6-payloads.json), [SQL cases](fixtures/sql-cases-m5.json); the [selective-delivery example](examples/m6-selective-delivery/workflow.json). |

## Section and scope fingerprints

A **section hash** is the SHA-256 of the exact section bytes, its canonical index entry, the hashes of its `dependsOn` sections and, for the `map` section, the bytes of `implementation-map.json`. Informative sections affect nothing that does not depend on them, and nothing normative may depend on them.

A slot's **scope hash** covers the normative closure of its roots, where the roots are `scopeRefs` if given, otherwise the view's sections: the public selector for `public`, every normative section for `full`. A `full` view without `scopeRefs` also covers every bundle file other than the document, the index and the map.

The **reviewer fingerprint** is a Merkle hash over the reviewing Agent's whole upstream input closure: the definition of every node feeding its prompt and files (instructions reaching it through any template slot, selectors, Routes and Merges) and of every After prerequisite, the Agent itself and its Context policy, plus the workflow's native configuration (`settings.nativeConfiguration`). The walk stops at the prepare Gate, whose subject-derived values the scope hash covers. When an input's content cannot be established from definitions alone (another Agent, a Loop, a Map, another Gate, a workspace File Input, a Loop boundary value, a Continue Context whose native history moves, or a Context that any other Agent or Map role also writes, since that writer may change the reviewer's native history), the fingerprint is unknown and the slot fails closed to a live review. The engine finds the Agent from the evaluate slot, either directly or as the Agent alternative of a selected Merge.

## Selective review

Prepare with `carry: true` reads `prior`: a stored GateCertificate reference, or null for a first revision. For each slot, the prior review is the certificate's review for that slot (a ReviewRecord or an earlier ReviewCarry). The slot's status is:

| Status | Condition | `needsReview` |
| --- | --- | --- |
| `missing` | No prior certificate or no review for the slot | true |
| `stale` | The prior was not approved, or the scope hash, reviewer fingerprint or policy differs, or a blocker raised by this slot (`ISS-<SLOT>-…`) is still open | true |
| `carried` | Everything matches for a different subject | false |
| `current` | Everything matches and the subject is identical | false |

`<slot>-need` is a `reviewNeed`. When no review is needed it holds a `reviewCarryRequest`.

Wiring per slot: a Route with selector `/needsReview` (`live` = true, `carried` = false) and value = the need. The live branch feeds the reviewer's prompt, so the Agent is skipped when its approval is carried. The carried branch selects `/carry`. A selected Merge joins the Agent `json` and the carry request into the evaluate slot. Every join resolves before evaluate.

Evaluate accepts a carry request only if the plan marked that slot carried with the same prior review and scope hash. The stored prior must still match the scope, the policy and the reviewer fingerprint, and must be approved. It then writes a `ReviewCarry` record (old and new subject, prior review, fingerprints) and journals `gate.review_carried`. The certificate lists the carry record among its reviews. A rejection or blocker is never turned into a carried approval, and a forged or unplanned carry request fails evaluate with `output_contract`. Live reviews record their scope hash, policy fingerprint and reviewer fingerprint, so later revisions can carry them.

## Map carry across revisions

A **task fingerprint** hashes the task definition, the hashes of its normative closure, the base manifest, the workflow's native configuration, its executor role, any embedded triage role and review roles, and the fingerprints of its dependencies. M6 MapStates record the fingerprint of every task and, for accepted tasks, the criterion evidence records, so a carried selection keeps its CheckReport proof for final delivery review.

With `carryAcrossRevisions: true` and a `prior-state` for a different subject under the same template fingerprint, a prior selection is carried when all of these hold:

- the task was accepted with a selected result and is not targeted by a repair;
- its recorded fingerprint equals the current one (a missing fingerprint never carries);
- every dependency was carried as well.

The execution is a new generation with a fresh verification counter. Each carried task gets a `TaskCarry` record and `carriedFrom` provenance, and keeps its original TaskResult. Everything else runs fresh: a changed contract invalidates every task whose closure reaches it, and their consumers. Same-subject carry follows the M5 rules and also requires equal fingerprints when they were recorded.

## History, navigator and Replay

- `…/executions` lists this run's executions of the Map instance, then follows each `priorExecutionId` across runs, with generation, subject, state, carried count and progress.
- `/map-executions/{id}` serves the same navigator for any execution, historical ones included. Each task lists its result history (`pending`, `accepted`, `rejected`, `withdrawn`, `carried`) and its carry provenance.
- Replay folds `map.*` events into a per-execution projection (tasks, counter, pause, records) at every step. Generated task scopes can therefore be stepped through from the journal alone, with no provider calls.

## Reference exercises

`npm test` (`runtime/tests/revisions.test.mjs`) covers:

- a changed internal contract keeps the Customer approval (carried with provenance) while readiness re-reviews, and only the independent auth tasks are carried;
- a changed auth contract invalidates every dependent task;
- an edited reviewer prompt, or an open blocker raised by a slot, forces that reviewer to run live;
- carry decisions fail closed on unknown fingerprints, and evaluate refuses an unplanned carry;
- a reviewer inspects immutable snapshot A while another task is produced;
- generation history and the Replay Map projection across both runs.
