# 12. Consolidated finding register and remediation matrices

- **Inputs:** [architecture review](../../reviews/deszo-rust-migration-architecture-review.md) (AR-01 to AR-16, verdict BLOCKED) and [security review](../../reviews/deszo-rust-migration-security-review.md) (SR-01 to SR-10 and SR-H1, verdict BLOCKED).
- **Method:** each finding was checked against the written design and the source contract it cites before it was accepted. Verification notes record what was confirmed in source. Overlapping findings are grouped; each reviewer's unique evidence stays in its own row.
- **Status values:** *Remediated in design* (the contradiction is removed and the contract is specified); *Remediated, proof pending* (contract specified, feasibility or implementation proof named); *Owner decision* (the correction depends on a decision listed in [09 §2](09-open-decisions.md#2-owner-decisions)).

## 1. Register

| ID | Severity | Contradiction or missing guarantee | Source contract (verified) | Correction | Documents | Required verification | Owner decision | Status |
|---|---|---|---|---|---|---|---|---|
| AR-01 / SR-01 | Critical | Admission accepted labels for Parent, incident and Repair; 04 §2.2 allowed a Repair the Engine started for any reason. P2 authorization was dropped | `startWorkflowJudgeRepairInTransaction` checks designated Judge policy digest, pinned profile, exact failed node, settled P3 outcome and revision, one durable link per incident and one active link per Parent (`runtime/core/linkedRepair.mjs:968-1023`, `:996-1006`); Gate binds the exact authorization (`runtime/core/p5Gate.mjs:754-790`). Confirmed | Gateway-registered Parent; custody records labeled by node; Host-launched designated Parent Judge; one `RepairAuthorization` per registration, bound to the failed node attempt of the pinned profile, issued only after the incident reproduces on the baseline from Host-held inputs; consumed with the claim of the generation's own slot; carried through Gate, acceptance and cutoff (re-review NS-2, NA-5) | 04 §2, 03 §4-5, 05 §5-6, ADR-0012 §5.4 | Refusal of invented, substituted, stopped, stale, reused, wrong-node, non-reproducing and cross-publication cases (07 §5) | None: the P3 classification becomes a label, and the stricter baseline reproduction stands in for it before any slot is consumed | Remediated in design |
| AR-02 | High | `SubmitCandidate` started verification and acceptance asynchronously; the Judge node only read status; `wait` missing; review-set delivery undefined | Exact enrolled Gate Attempt (`p5Gate.mjs:761`); Judge action set (`runtime/core/workflowJudge.mjs:18-21`, `:471`); complete review delivery (`:988-1000`); `reject_repair` fails the Repair (`:906-908`). Confirmed | Capture stays asynchronous; Gate and acceptance Judge run only on asynchronous checkpoint delegations at the bound node and Attempt; full decision set; complete required review set or refusal; failed Gate and rejection terminal (re-review NS-3) | 04 §5 | Early, wrong-node, reused-attempt, post-rejection and incomplete-review refusals; wait, evidence and budget scenarios | None | Remediated in design |
| AR-03 / SR-02 | Critical (SR), High (AR) | No trusted issuer of Workflow resource grants; the long-lived Engine received the union of workspace grants; one provider principal shared grants; the Engine chose which scope a Run received (re-review NA-1, NS-1) | Current single primary workspace per Run (`runtime/core/engine.mjs:2509`); Custody reserve takes Engine-supplied cwd (`lifecycle-host/src/custody.rs:835`); Run-creating routes (`runtime/runner.mjs:356`, `:376`, `:404`). Confirmed | Owner-authenticated bindings and publication policy; scopes only for gateway-witnessed Run starts or Host-recorded derivations (children never wider); no fallback on a publish mismatch; legacy scope only for Owner-confirmed inventory; per-Run principals; Engine without workspace grants | [13](13-workflow-resource-scopes.md), 02 §2, 02 §7, 03 §3, 06 §5 | PR-2 and PR-8 for OS enforcement; scope issuance refusals (07 §5) | OD-1 (cutover confirmation, unsupported providers) | Remediated in design; OS enforcement proof pending |
| SR-03 | High | Host capture proves which local invocation emitted bytes, not that the enrolled CLI is honest; Engine could relabel a protected question | Custody tool binding by path and digest (`custody.rs:1157-1175`); current question UI rendered from Engine data (`src/App.tsx:892`). Confirmed | Isolated Judge principal and configuration per invocation, pinned executable, nonce-bound dossier, sealed capture; Host-rendered protected questions; explicit Owner trust decision for the enrolled CLI | 04 §4, 05 §6 | Cross-job spool, tool or config substitution, stale decision, replayed answer, relabeled question refusals | OD-10 (trust in the enrolled Judge executable) | Owner decision |
| AR-05 / SR-04 | High | Candidate-authored reproducer, generic pass/fail and `--list` replaced the enrolled causal predicate; equal-metadata rule contradicted a new test target | P5-CLOSURE A2: enrolled `causalReproduction` check, harness assertions pass and defect assertions fail with assertion failures on the baseline, incident inputs, complete report ([amendment](../../reviews/2026-10-30-p5-closure-architecture-amendment.md)). Confirmed | Enrolled, protected, out-of-process harness driving the built Engine over the protocol with Host-held incident inputs; assertion classes observed by the harness, not by candidate code; refusal of incomplete, skipped, crashed, timed-out or wrong-class outcomes | 04 §6 | PR-9 harness feasibility; refusal fixtures for each outcome class | None (A2 preserved) | Remediated, proof pending |
| SR-05 | High | Process and channel isolation unproven; legacy listeners and the standalone custody service remain | Standalone `custody-serve` entry (`lifecycle-host/src/main.rs:37`); Decision C left children, cross-container and duplication unshown. Confirmed | Fail-closed launch with token, handle list and Job set before execution; every child-reachable listener removed or re-authorized; channel possession treated as Engine-domain authority | 03 §1, 03 §6, 09 §1 | PR-1, PR-5 expanded | OD-3 for any platform exclusion | Remediated, proof pending |
| AR-04 / SR-06 | High | Engine build ID derived from a receipt that hashes the binary containing it; no serialized commit guard | Current builder takes the ID before building (`runtime/core/p6Builder.mjs:420-429`). Confirmed | Host-issued immutable `BuildIntent`; ID derived from the intent before compilation; receipt binds intent, outputs and package; eligibility cutoff under the admission lock at the drain acknowledgement and a selector and package unchanged check before the selector write | 04 §7, 04 §9 | PR-4; altered recipe, swapped output, stale receipt and Stop-interleaving refusals | None | Remediated in design |
| SR-07 / AR-14 (build closure part) | High | Unrelated commit with a compliant diff could pass; Cargo configuration and tool discovery not sealed; outputs collected by pathname | Managed Git ancestry contract (`runtime/core/p5GitCandidate.mjs:1290-1304`, [§25.5](../../reviews/2026-10-29-p5-managed-git-ancestry-and-host-boundary.md)); migration runner protected (`runtime/core/p6Scope.mjs:168`). Confirmed | Slot repository and seed recorded at preparation; candidate parent must be the seed; quiesced sealing; sealed work root with no writable ancestors, pinned absolute tools, explicit package and test selection; handle-safe output collection after proven termination; migration runner and catalog protected | 04 §3, 04 §7 | PR-3, PR-6 expanded | OD-8 | Remediated, proof pending |
| AR-06 | High | The last free slot admitted a Repair whose successor had no slot; no successor seeding or source materialization proof before stage | Successor slot decided before intent (`runtime/core/p6Consumer.mjs:443`); source continuity proof before staging (`:536-542`); ordered next slot (`runtime/core/p6Continuation.mjs:320-326`). Confirmed | Existing timing kept: before `BuildIntent`, the Host requires the ordered next slot to be free and eligible and seeds it from the retained accepted objects; exhaustion refuses before any build or stage | 04 §8 | Two-slot exhaustion fixture; seed failure refusal | None (timing unchanged) | Remediated in design |
| AR-08 / SR-08 | High | No single ordering among journal, slot file, successor file and selector; no defined eligibility cutoff; retry and replay undefined | Final durable eligibility (`runtime/core/p6Consumer.mjs:171-189`); selector commit (`lifecycle-host/src/engine_switch.rs:824`). Confirmed | One protected journal plus the selector; projections; `eligibility_cutoff` journaled at A's drain acknowledgement, the same point as ADR-0010 §5 (re-review NA-4); Engine `ReportInvalidation` duties mirroring `p5Eligibility`; `switch_prepared` before the selector; retries only after abandonment | 04 §9, 05 §3 | Crash at every boundary; duplicate delivery; cutoff race and parity tests | None (cutoff unchanged) | Remediated in design |
| AR-07 / SR-09 | High | A shared `DeszoEngine` principal had live Store access, so copy-only preflight was a convention | Preflight checks sender, identities and copy digest while recording candidate-reported fields (`engine_switch.rs:518-560`). Confirmed | Per-build Engine principal; Store grant moves from A's to B's principal only after commit; maintenance-only dispatch; Host-independent catalog check | 04 §10, 02 §7 | PR-1 extension: precommit denial, grant transition time on a large Store, postcommit start | OD-9 only if the grant transition is not feasible | Remediated, proof pending |
| AR-09 | High | Protected answers and Stop were recorded before validation | Stop validation (`engine.mjs:4309`); answer validation and receipts (`workflowJudge.mjs:1121`, `:1243`). Confirmed | Host-side closed command validation, typed schema, pending and freshness checks, one-time consumption, durable receipts and retrieval, serialized with the eligibility cutoff | 05 §6 | Malformed, stale, duplicate and superseded answers; Stop races | None | Remediated in design |
| AR-10 | High | New Engine lock does not exclude the Node runner's `runner.lock.db` | `runtime/lock.mjs:38` exclusive SQLite lock. Confirmed | Rust Engine acquires the same `runner.lock.db` lock with the same protocol during the compatibility window | 05 §2, 06 §4 | Lock interop test with both runtimes | None | Remediated in design |
| AR-11 | High | Cutover relied on a migration-only backup and a reopen test | Backup only on version advance (`runtime/core/store.mjs:47-54`). Confirmed | Cutover journal with explicit checkpoint and one ownership commit; downgrade limited to the pre-divergence checkpoint unless semantic compatibility is proven | 06 §5 | Restart at each cutover step; checkpoint restore rehearsal | OD-2 (downgrade window) | Remediated in design |
| AR-12 | Medium | Semantic imports and backfills omitted; all objects treated as canonical JSON | Legacy publication import (`engine.mjs:1442`); reference backfill (`store.mjs:102`); raw `putBytes` and `putText` (`store.mjs:135-159`). Confirmed | Supported upgrade origins, semantic import parity, raw-digest check for every object and canonical check only for JSON objects, existing per-read corruption behavior | 05 §2 | PR-7 expanded with older profile fixtures | OD-2 (supported origins) | Remediated, proof pending |
| AR-13 | Medium | Blanket 4 MiB bound; Judge token header dropped; autonomy GET and POST differ; MCP and UI setup depend on Node paths | Raw artifact bound only on request (`runtime/runner.mjs:558-567`); `X-Deszo-Judge-Token` routes (`:419-422`); autonomy GET 200 versus POST error (`:249-256`); descriptor checks (`mcp/runtime-client.mjs:12-29`); UI config generator (`src/App.tsx:1146-1152`). Confirmed | Per-route parity inventory, chunked raw streaming, header list per surviving route, versioned discovery and setup generator, registration migration | 05 §6, 05 §7 | Route parity tests; MCP reconnect and rediscovery | OD-5 | Remediated in design |
| AR-14 (bootstrap part) | Medium | First Engine needed a successor receipt; enrollment ordering contradictory | Initial manifest check (`lifecycle-host/src/lib.rs:1069`). Confirmed | `BaselineInstallation/1` written by the maintainer installer; order install → baseline record → Owner enrollment → start | 02 §6, 06 §5 | Cutover rehearsal | OD-2 | Remediated in design |
| AR-15 | Medium | Milestone gates used later work; no test packaging before packaged E2E; PR-2 too late; baseline record only in M9 (re-review NA-3) | Design 06 and 10 as written. Confirmed | Gates limited to delivered slices; test packaging with a test-only baseline record in M4; M6 Engine packaged for M8; provider feasibility before provider parity; build crash tests in M8 | 06 §2, 10 | Gate review per milestone | OD-7 closed by default | Remediated in design |
| AR-16 | Medium | Thread isolation over-claimed; Host kills only on Stop contradicted existing deadlines | Custody capture failure and deadlines (`custody.rs:1341`, `:1395`). Confirmed | Bounded parsing and quotas, priority lanes, short critical sections, stated fault limits; existing custody deadlines and capture-failure termination kept | 02 §10, 02 §4 | Stalled reader, exhaustion and injected admission failure tests | None | Remediated, proof pending |
| SR-10 | High | Cutover kept a bearer value that the old topology exposed; protected admission followed an uncontained window (re-review NS-4) | Decision C §2 demonstration. Confirmed | Rotate at cutover, retire old descriptors and listeners, rebootstrap UI and clients; enrollment at cutover only with re-pinned provider and Judge installations and freshly seeded slots, or on a fresh profile | 05 §7, 06 §5, 09 OD-11 | Old bearer refused; UI and MCP rediscover; enrollment refused without the cutover trust steps | OD-11 (cutover trust) | Remediated in design; Owner decision |
| SR-H1 | Critical (current Node architecture) | Shared Host authority bypassed P5 | Decision C §2; `lib.rs:1786` | Release block kept on the Node topology; Rust target removes the verbs and the shared capability | 06 §4, 03 §4 | Refusal evidence under SR-05 | None | Remediated in design (historical block retained) |
| AR-doc (architecture review §4) | Low | 01 §2 named a `deszo-domain` crate that 02 §5 does not define | Design text. Confirmed | 01 §2 corrected to `deszo-protocol` and `deszo-workflow` | 01 §2 | Documentation check | None | Remediated in design |

## 2. Architecture remediation matrix

| Finding | Before | After |
|---|---|---|
| AR-01 | Labels at `ClaimSlot` | `RepairAuthorization` issued from a Host-launched Parent Judge on a Host-registered Parent, consumed with the claim (04 §2) |
| AR-02 | Asynchronous verification and acceptance on submission | Asynchronous checkpoint delegations at the enrolled Gate and Judge nodes and Attempts; terminal rejection and Gate failure; complete review delivery (04 §5) |
| AR-03 | Engine and shared provider grants | Host resource bindings, publication policy, scopes only for witnessed or derived Runs, per-Run principals (13) |
| AR-04 | Receipt-derived build ID | Intent-derived build ID (04 §7) |
| AR-05 | Candidate reproducer | Enrolled out-of-process causal harness (04 §6) |
| AR-06 | Free-slot check only | Ordered successor slot check and seeding before `BuildIntent` (04 §8) |
| AR-07 | Shared Engine Store grant | Per-build principal and commit-time grant transition (04 §10) |
| AR-08 | Separate files without ordering | One protected journal, projections, `eligibility_cutoff` at the drain acknowledgement, `switch_prepared` and `switch_abandoned` around the selector (04 §9) |
| AR-09 | Record then forward | Validate, consume once, receipt, then forward (05 §6) |
| AR-10 | New lock file | Same `runner.lock.db` protocol (05 §2) |
| AR-11 | Migration backup and reopen | Cutover journal, checkpoint, ownership commit, bounded downgrade (06 §5) |
| AR-12 | SQL and canonical-only proof | Semantic imports, raw versus canonical objects, origins (05 §2) |
| AR-13 | Blanket bounds and header list | Per-route parity, streaming, discovery versioning (05 §6-7) |
| AR-14 | Universal receipt rule | Baseline installation record; protected migration runner; explicit Cargo selection (02 §6, 04 §3) |
| AR-15 | Gates referencing later work | Corrected stage gates, test packaging with a test-only baseline record, M6 Engine packaged in M8 (06, 10) |
| AR-16 | Thread isolation claim | Bounded work, lanes, deadlines kept, stated limits (02 §10) |

## 3. Security remediation matrix

| Finding | Principal | Before | After | Enforcement |
|---|---|---|---|---|
| SR-01 | Engine | Repair origin unauthenticated | Gateway-registered Parent, Host-launched Parent Judge, one authorization per registration bound to the failed node, baseline reproduction before any slot is consumed | Host state, custody and Host-launched invocations |
| SR-02 | Engine, providers, descendants | Union of grants; Engine-written scope; Engine-chosen scope | Owner-authenticated bindings and policy; scopes only for witnessed or derived Runs; Owner Stop ends a scope; per-Run principal; Engine without workspace grants | OS capability grants (PR-2, PR-8) |
| SR-03 | Judge CLI, Engine-mediated UI | Capture without trust rule; Engine-rendered consent | Isolated invocation, sealed capture, Host-rendered questions, explicit trust decision | Containment plus OD-10 |
| SR-04 | Candidate code | Candidate-process observations | Out-of-process enrolled harness | Separate principals for harness and candidate (PR-9) |
| SR-05 | All contained | Isolation unproven | Fail-closed launch, removal of legacy entries | PR-1, PR-5 |
| SR-06 | Engine, build job | Circular ID; unserialized commit | Intent ID; joined operation; serialized check | Host journal and selector |
| SR-07 | Developer, jobs | Unbound history; unsealed tools; path collection | Seed-bound ancestry; sealed root; handle-safe collection | Host checks plus PR-3, PR-6 |
| SR-08 | Engine replay, Host crash | Divergent files | One journal, projections, exact recovery | Host journal |
| SR-09 | Candidate B | Shared Store grant | Per-build principal; grant after commit | OS grant (PR-1) |
| SR-10 | Retained old bearer; uncontained window | Old value kept; admission after the Node-era window | Rotation and rediscovery; cutover trust steps (OD-11) | Gateway; Owner decision |
| SR-H1 | Node Engine | Shared capability | Release block retained; verbs removed in target | Protocol design |

## 4. Reviewer points not adopted as written

- **Claim-time reservation of the successor slot (SR §15).** The security review asks to enforce the spare at claim. The current contract checks the successor slot before the P6 operation intent, after the Repair has claimed its own slot (`p6Consumer.mjs:443`), and the architecture review classifies a change of timing as an Owner decision. The design keeps the current timing; the property the security review needs (no build, stage or switch without a successor slot) holds because the check precedes `BuildIntent`.
- **Independently authenticated Judge decisions (SR §8).** No supported provider CLI offers a decision signature bound to a dossier and nonce. The design hardens the invocation and makes the trust in the enrolled executable an explicit Owner decision (OD-10) instead of claiming independence it cannot provide.
- **Endpoint-level network allowlists (SR §10).** AppContainer network capabilities do not express destinations. The resource policy can grant no network or the provider network capability; destination allowlists need a broker and are not in v1. A policy that asks for a destination allowlist is refused rather than widened (13 §5).

## 5. Independent re-review

Two fresh-context, read-only re-reviews of the first remediation, each checking its own register rows. Both returned **BLOCKED**. Their findings were checked against the source and the documents and corrected as follows.

| ID | Severity | Finding | Verified | Correction | Documents |
|---|---|---|---|---|---|
| NA-1 / NS-1 | High | The Engine chose which Owner-authorized scope a Run received; the legacy and publish-mismatch fallbacks were fail-open | Yes: `Scope::Issue` named the publication; only Parent starts were witnessed | Scopes only for witnessed Run starts or recorded derivations; `pending` until then; no fallback; Owner-confirmed legacy inventory | 13 §1.1, §6; 05 §6.2; 07 §5 |
| NA-2 | High | Cutover did not carry existing workspaces into bindings, so legacy Runs would fail | Yes | Cutover inventory confirmation step with journaled, reversible access-control changes | 06 §5 step 6; 13 §6 |
| NS-3 | High | The Engine could ignore a rejection or Gate failure and retry | Yes: `reject_repair` fails the Repair today (`workflowJudge.mjs:906-908`) | Terminal outcomes journaled; later checkpoints refused; retries only after abandonment | 04 §5.1, §9 |
| NS-4 | High | Protected admission after the uncontained Node-era window contradicted 03 §7 | Yes | OD-11 cutover trust: re-pin provider and Judge installations, freshly seed slots, or use a fresh profile | 06 §5 step 7; 09 OD-11; 03 §7 |
| NS-2 / NA-5 | Medium | One authorization per incident, failed-node binding, Parent Judge budget, slot assignment and registration race were missing | Yes (`linkedRepair.mjs:996-1006`) | One authorization per registration; failed node attempt of the pinned profile; budget; baseline reproduction before authorization; generation's own slot; pending `RunStart` before forwarding | 04 §2.3-2.4; 13 §1.1 |
| NA-4 | Medium | The eligibility cutoff moved and dropped `p5Eligibility` conditions | Yes (`p6Consumer.mjs:171-189`) | Cutoff kept at A's drain acknowledgement; Engine reporting duties mirror `p5Eligibility`; parity test | 04 §2.4, §9 |
| NA-3 | Medium | M4, M7 and M8 needed the baseline record delivered in M9 | Yes | Test-only baseline record in M4 test packaging; M6 Engine packaged in M8 | 06 §2; 10 |
| NA-6 | Medium | The Parent Judge was described inconsistently; its questions were Engine-rendered | Yes | 02 §3 corrected; Parent `request_human_input` is a Host protected question | 02 §3; 04 §2.3 |
| NA-7 | Medium | Catalog lacked checkpoint results, answer arrival, preflight result and the role transition | Yes | `Protected::CheckpointResult`, `Protected::AnswerArrived`, `Protected::Invalidated`, `Scope::Ready`, `Lifecycle::PreflightResult`; `Proceed` is the only role transition; asynchronous checkpoints | 05 §5; 04 §4, §10 |
| NA-8 | Medium | Node Stop invalidated the chain, which today it does not | Yes (`engine.mjs:4354`) | Invalidation only for run-level Stop, stop-and-report and the Host admission Stop | 05 §6.2, §6.4 |
| NA-9 | Medium | Cutover imported claims before enrollment and required enrollment | Yes | Import after optional enrollment; without enrollment admission stays closed | 06 §5; 05 §4 |
| NS-5 | Medium | Owner Stop of a Repair depended on the Engine-registered Run id | Yes | Host-rendered protected view with an admission Stop keyed by Host ids | 05 §6.2, §6.4 |
| NS-6 / NA-10 | Low | Shared build principal; Engine network unspecified; build-script reads; `migrate.rs` and `catalog.rs` not protected in 02 §5; stale 01 §3 reference; publication route check; derived drafts; build-ID variable in the environment digest; README overstatement | Yes | Per-job build principals; Engine without network (PR-1); build-script behavior stated as not a boundary; protected paths aligned; references fixed; publication route checked; derived drafts witnessed; variable excluded; README corrected | 02 §2, §5; 01 §3; 04 §7.1-7.2; 05 §6.2; 13 §1; README |
| PR-8 gap | - | No negative case for starting a child with an unheld capability | Yes | Added to PR-8 | 09 §1 |

Register rows corrected after the re-reviews: AR-01 / SR-01, AR-02, AR-03 / SR-02, AR-08 / SR-08, AR-15, SR-10.

### 5.1 Final delta review

The two reviewers checked the corrections above.

| Review | Result | Findings | Disposition |
|---|---|---|---|
| Architecture delta | BLOCKED | NB-1 (High): the derived-scope rule gave an ordinary Judge-requested Repair no workspace of its own, contradicting today's non-overlap rule (`runtime/core/linkedRepair.mjs:204-216`). NB-2 (Low/Medium): record order around the cutoff inconsistent; no record for a blocked cutoff. NB-3 (Low): three matrix rows overwritten by register rows; stale wording | NB-1: ordinary Repair scope derived from the pinned profile's non-overlapping binding, profile pinning witnessed with the publication (13 §1, §1.1, §6). NB-2: one order (drain, cutoff, `switch_prepared`, selector, `switch_committed`) with `switch_abandoned` and `Lifecycle::Resume` (04 §8-9, 05 §5, ADR-0012). NB-3: matrices restored, wording fixed (12 §1-3, 04 §10, README, 01 §3) |
| Security delta | PASS WITH PREREQUISITES | ND-1 (Medium): an Owner Stop did not end a Run's scope. ND-2: candidate-job timeouts could be retried as abandonment. ND-3: OD-11 covered only enrollment at cutover. ND-4: a Stop after the cutoff had no explicit answer. ND-5: register and wording defects (same as NB-3) | ND-1: validated run-level Stop ends the scope and its derived scopes (13 §5, 05 §6.2). ND-2: timeouts, crashes and hangs of candidate-code jobs are refusals (04 §9). ND-3: OD-11 applies to every later enrollment (09, 06 §5). ND-4: `X-Deszo-Protected-Effect` states `blocks_installation` or `after_cutoff` (05 §6.4). ND-5: as NB-3 |

### 5.2 Confirmation of the last corrections

| Review | Result | Remaining points | Disposition |
|---|---|---|---|
| Architecture confirmation | **PASS WITH PREREQUISITES**: NB-1, NB-2, NB-3 resolved; no new contradiction | Low: the Stop grace bound in 13 §5 was not defined | 13 §5 now names it as a custody parameter frozen in M0 and notes that the current source has none |
| Security confirmation | **PASS WITH PREREQUISITES**: ND-1 to ND-5 resolved; the ordinary-Repair derivation opens no authority gap | Low: state that a kind-2 derivation is refused after the Parent's scope ended and that a Parent Stop ends kind-2 Repair scopes | Added to 13 §1.1 and 13 §5 |

The two Low wording additions were applied as the reviewers worded them and were not separately re-reviewed.

## 6. Verdict

**`DESZO-RUST-MIGRATION-SD REMEDIATION VERIFIED WITH PREREQUISITES`**

All design-breaking findings of both independent reviews (AR-01 to AR-16, SR-01 to SR-10, SR-H1) and of the two re-review rounds (NA, NS, NB, ND) are resolved in the design contracts, and both fresh-context reviewers confirmed the final state as PASS WITH PREREQUISITES. Outstanding, and explicitly testable or decidable:

- **Feasibility prerequisites PR-1 to PR-9** (PR-10 was added later by 14, for Variant 3 only) ([09 §1](09-open-decisions.md#1-prerequisites)), none executed: Windows containment and the G0 grant transition (PR-1), provider CLIs under Run scopes (PR-2), contained Cargo builds (PR-3), reproducibility (PR-4), channel separation (PR-5), Git identity (PR-6), Store compatibility (PR-7a, PR-7b), capability grants and per-Run principals (PR-8), harness separation (PR-9).
- **Owner decisions OD-1 to OD-11** (OD-12 to OD-15 were added later by 14) ([09 §2](09-open-decisions.md#2-owner-decisions)); OD-1, OD-10 and OD-11 carry security weight, and OD-9 applies only if PR-1 cannot bound the grant transition.
- **M0 freeze items** named by the reviewers: the Stop grace bound, the Run-creating route list, the record kinds and the protocol catalog.

No missing authority is recorded as an accepted limitation. Trust in the pinned enrolled Judge executables (OD-10) and in the Owner's account state at cutover (OD-11) are explicit, scoped Owner decisions.

## 7. Self-Repair scope reconsideration (2026-11-06)

The Owner decided that only a fixed, default-deny subset of the Engine source is repairable, and that the scheduler and the whole Self-Repair control path are protected. [14](14-self-repair-scope-reconsideration.md) reassesses Host Admission under that decision.

- **Result:** `SELF-REPAIR SIMPLIFICATION PARTIALLY RECOMMENDED`. The in-process protected-source model is blocked. With repairable code in an OS-contained component worker (PR-10) and the Owner's acceptance of the residual list (OD-12), the protected Engine Core can keep P2, the Gate classification, acceptance and question handling. The Host keeps witnesses and scopes, the Stop and claim journals, sealing at capture, builds before the Gate, the harness against built bytes, the successor and G0.
- **Register rows affected only if Variant 3 is chosen:** AR-01 / SR-01 (P2 returns to the protected core; Parent witness, claim journal and reproduction stay), AR-02 (checkpoints become protected-core logic), SR-03 (questions under OD-12), AR-05 / SR-04 (harness kept, now against the built package), AR-09 (questions under OD-12; Stop journal stays). AR-03 / SR-02 is unaffected.
- **Contract limitations found:** CL-1, no Judge attention after a terminal Repair outcome (OD-13); CL-2, the capture anchor precedes the boundary check (OD-15).

## 8. Self-Repair scope challenges

Two fresh-context, read-only challenges of the first version of 14. Both returned **BLOCKED**; 14 was rewritten.

| ID | Severity | Finding | Verified | Disposition in the revised 14 |
|---|---|---|---|---|
| SC-1 / AC-1 | Critical | `#![no_std]` is not a capability restriction (`extern crate std;`); safe-code soundness exploits exist (rust-lang/rust#25860) | Yes (language rules) | In-process confinement rejected; OS-contained component worker (§3) |
| SC-2 / AC-2 | High | Code marked repairable feeds P3, P2, Judge decoding, Task gating and limits (`engine.mjs:3951-3958`, `taskRuntime.mjs:434`, `:542`) | Yes | Classification rule: no protected decision consumes worker output without a trusted check; protected-role adapter copies; incident reproduction kept (§4, §5) |
| SC-3 | High | Tested bytes were not installed bytes; required tests modifiable | Yes | Seal at capture; Host builds before the Gate; harness drives the built package; required tests and harness outside the allowed tree (§5, §8) |
| SC-4 | High | Reverse routes: exported macros, trait impls on returned values, auto-discovered crate roots | Yes | Repairable code is not linked into protected crates; protected boundary crate; auto-discovery disabled (§3, §8) |
| SC-5 / AC-3 | High | Scope and Stop witnessing are not Self-Repair machinery | Yes | Witnesses, scopes and Stop journal kept in the Host; 13 unchanged (§5, §6) |
| SC-6 / AC-7 | Medium | Activation request lacked Host-side bindings; Host took an Engine-reported slot | Yes | Claim journal, Parent witness, seal, receipt, harness job and Stop checks on `RequestActivation` (§6) |
| SC-7 | Medium | Judge isolation dropped | Yes | Custody Judge profile (§5) |
| SC-8 / AC-6 | Medium | Policy and PR-10 gaps: new manifests or `build.rs` under allowed paths, auto-discovered roots, ASCII and case rules, two interpreters | Yes | `deny_names`, auto-discovery disabled, ASCII and case-insensitive rules, Host as the only interpreter (§8); PR-10 redefined |
| SC-9 / AC-4 | Medium | In-process aborts, hangs and static state cannot be bounded | Yes | Worker isolation; failures map to P3 (§3.2) |
| AC-5 | High | The Judge cannot explain a scope refusal; capture anchor precedes the boundary check (`engine.mjs:892-910`, `workflowJudge.mjs:414-418`) | Yes | Typed scope-refusal record; CL-2 and OD-15; OD-13 limited (§7) |
| AC-7 (usefulness) | Medium | The repairable region is small and excludes the repairs P5 has performed | Yes | Stated for OD-14 (§4, §12.2) |
| AC-8 | Medium | Roadmap and document inconsistencies (OD-12 before PR-10, missing affected sections, label collision, missing §8) | Yes | Decision point revised (10); affected sections listed (§12.3); variants renamed 1-3; this section added |
| AC-9 | Low-Medium | Stop between `DrainAck` and commit could be lost | Yes | Stop journaled and re-delivered on `Resume` (§5) |

### 8.1 Confirmation of the revision

| Review | Result | Remaining points | Disposition |
|---|---|---|---|
| Architecture confirmation | **PASS WITH PREREQUISITES**; AC-1 to AC-9 resolved | N1 (Medium): every Judge invocation is a protected role, and the rule concerns authority decisions; N2: successor check moved after the build; N3: two executables not listed; N4: retry path unnamed; N5: stale prerequisite ranges; wording of the reproduction row | All applied in 14 §4, §5, §6, §7, §12.3 and in 06, 10, README, ADR-0012 |
| Security confirmation | **PASS WITH PREREQUISITES**; SC-1 to SC-9 resolved | §9: worker messages as a data source and persistence of the installed worker; G-1: 13 §1.1 derivation; G-2: worker covered by package rules; G-3: seal-slot binding and reproduction job record at activation | All applied in 14 §3.2, §5, §6, §9, §12.3 and 13 |

These last corrections were applied as the reviewers worded them and were not separately re-reviewed.

**Verdict of the reconsideration:** `SELF-REPAIR SIMPLIFICATION PARTIALLY RECOMMENDED` (14 §12.2). The in-process variant is blocked; Variant 3 is coherent and enforceable by OS containment, subject to PR-1, PR-9, PR-10 and the Owner's decision OD-12.
