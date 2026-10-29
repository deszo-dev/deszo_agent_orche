# Deszo — P5 Protected Self-Repair Implementation Report

**Date:** 2026-10-28  
**Repository:** `C:\my\2026\deszo_agent_orche`  
**Branch / HEAD:** `codex/adr-0003-0005-completion` / `a41d03ffedf9ce55aab3e791d4e193f3bda0127d`  
**Architecture:** `docs/reviews/2026-10-28-p5-protected-self-repair-architecture.md`

## A. Verdict

**P5 IMPLEMENTATION NOT VERIFIED**

This work adds P5 contract/schema and candidate-capture primitives, a strict workflow Gate shape, and fail-closed guards. It also hardens helper-level enrollment, candidate and receipt consistency checks. It does not implement the supported P5 lifecycle. The Engine has no installed enrollment loader; it rejects every P5-capable publication and Self-Repair P2 admission. The verification Gate always refuses execution. No candidate can reach P4/P2 acceptance through this implementation.

Do not use this branch state as P5 acceptance evidence or mark it ready for P6.

## B. Source baseline and worktree

- Starting branch and HEAD: `codex/adr-0003-0005-completion`, `a41d03ffedf9ce55aab3e791d4e193f3bda0127d`.
- Before implementation, the only worktree item was the pre-existing, untracked P5 architecture review. There were no tracked modifications or staged changes.
- Final tracked changes are listed in §C. The pre-existing untracked architecture review was updated only to define the canonical verification command and observation-set digests used by the new helper checks. This implementation report is also untracked.
- The source audit found the Engine/Gate checkout bytes are CRLF while the Git index bytes are LF. This checkout does not qualify for initial byte-identical P5 enrollment. No line-ending setting, source file, index, or repository state was normalized or reset.
- The current Engine has no installation-owned P5 enrollment or trusted running-source release binding. Windows inventory refuses to run without an injected native identity reader; no production Windows reader was added.
- Relevant SHA-256 hashes at the end of source implementation (before adding this report):

Final SHA-256 hashes for the modified/added source and schema files are:

| File | SHA-256 |
|---|---|
| `docs/reviews/2026-10-28-p5-protected-self-repair-architecture.md` | `24720303b887c9880ddf4917a9927f8cfda8de8c1bb3cafcd3ad909a0a2c49d9` |
| `docs/schemas/workflow.schema.json` | `172a7c7876c23c074d16654073c893753c2dd6123497e2a55c5fa821ab889eb0` |
| `docs/schemas/protected-self-repair.schema.json` | `d7f6b2d0ac2cc704f01ac62c9ac22c35c1fd9e1e3e825f09491b389e023c872e` |
| `runtime/core/protectedSelfRepair.mjs` | `29f42e432b8b0a4067090b416721626864acb624aa0e391d54346f2fc73c4df7` |
| `runtime/core/engine.mjs` | `702a4b51465b3dc039daae04cf98bfca28626d39f2ce6976bb674dbb5971216c` |
| `runtime/core/linkedRepair.mjs` | `a55acce28fc6b557b89227097bd6113556c99dabc571342ac2e7061ab69a1762` |
| `runtime/core/schemas.mjs` | `caece3a8c781e907d3c6ec17a2333cd50c0e6e56bc3202fbbf52437550df0ade` |
| `runtime/core/validate.mjs` | `a87205c991ca2d705a72657c296a5d877f8c9bb6310ac2e91bf72fe3c33dc6ab` |
| `runtime/tests/protected-self-repair.test.mjs` | `3be0ed58d62f37d4befd964c2f840716a455a5f1622ebc8bcc3119221ad6992f` |
| `src/Inspector.tsx` | `873a739efdce019929da6ae1c4f16ef508bebd315d90c41e509ec356c5a37f3a` |
| `src/model.ts` | `e976851ac783fcdffdf44dbca0597ebbdf392576dab7343ed073bcfd8816f2c8` |
| `src/nodes.tsx` | `98d686973509470285d5a9cf3b1608f2b303a70d3a42580270971df52d429d52` |
| `src/types.ts` | `f2f4741b5ff3c544c461bcf2a2cd92419b8aa963f373631371d5674e335a905d` |

The report file itself is excluded to avoid a self-referential hash.

The repository was checked for Node/Rust test or build processes whose command lines reference this checkout; none remained after verification. This does not assert that unrelated desktop Node processes were absent.

## C. Implementation inventory

### P5.1 — Contracts and admission

- Added `ProtectedSelfRepairProfile/1`, enrollment, source binding, verification policy/input, manifest, candidate, receipt, execution and handoff JSON Schema definitions in `docs/schemas/protected-self-repair.schema.json`, registered through `runtime/core/schemas.mjs`.
- Extended the workflow schema with `protected-self-repair-v1`, optional `selfRepair: ArtifactRef` on a Parent Repair profile, and `gate.config.mode = "self-repair-verify"`.
- Added workflow semantic checks for the P5 capability and top-level Gate restriction.
- Added a P2 guard that refuses a Self-Repair profile instead of silently opening an ordinary linked Repair.
- The repository identity contract is structured as repository-enrollment UUID + canonical Git common-directory path + native directory identity; the admission helper requires and compares an explicit current-identity value.
- **Not implemented:** installation-owned enrollment loading, a production Git common-directory/native identity collector, Git commit/tree/blob capture, dirty/effective-byte checks, runtime source provenance binding, enrollment compatibility checks, or a working privileged P5 admission path.

### P5.2 — Candidate primitives

- `runtime/core/protectedSelfRepair.mjs` provides portable ASCII path validation, canonical source/baseline/candidate and verification-command/receipt digests, bounded inventory, scope/change derivation, baseline object verification and source/change/candidate artifact construction.
- Enrollment consistency checks validate full publication/profile/policy/workspace/scope/budget/repository bindings and the enrolled baseline source object graph. Candidate capture verifies its stored baseline entries and exclusion list, compares the enrolled native workspace identity, matches authorization to stored profile/policy/inputs/source-binding/terminal records, and captures only the exact `<slot>/source` directory.
- Policy validation requires `requiredCheckIds`, `optionalCheckIds` and `requiredStages` to exactly match their check definitions. Receipt consistency checks validate candidate and baseline/source/change manifests, source and observation objects, candidate ID and scoped changes, and bind subject resolution, captured inputs, command/test-input manifests, execution-tree identity, assertions, output refs and source/harness digests to the candidate.
- A synthetic fixture test captures add/modify/delete changes, verifies a consistent synthetic receipt, and refuses scope expansion, changed source digest and a missing required check.
- **Not implemented:** P2 preparation intents, baseline materialization, dedicated slot registration/reservation, crash-safe workspace preparation, production Windows reparse/file identity, Developer dispatch binding, actual P2/Journal capture transaction, installed source closure, Git policy, or original-checkout E2E preservation.
- The inventory requires a caller-provided native identity reader on Windows. Tests use a fixture reader; this is not a production Windows topology proof.

### P5.3 — Verification Gate

- The workflow schema, TypeScript model, editor and port model expose a Gate with no caller inputs or configurable policy.
- `Engine.runGate` explicitly refuses it. P5 workflow admission is also rejected because enrollment is unavailable.
- **Not implemented:** trusted verifier, immutable command execution plan, per-incident inputs, candidate materialization, candidate subject resolution, B-pass/C-fail proof, Host-backed process execution, Gate Custody reattachment, observations, receipt issuance, or receipt journaling.

### P5.4 — P4/P2 approval

- The workflow profile can reference a P5 artifact. P2 expressly refuses it until complete enrollment, candidate capture, verification and recovery exist.
- **Not implemented:** P5 Judge dossier delivery, evidence-expansion lineage, candidate/receipt prerequisites, deterministic acceptance predicates, atomic P2 P5 approval, Stop invalidation, or `failed_node_retry=never` P5 handoff semantics.

### P5.5 — Recovery and handoff

- Versioned schemas and helper shapes exist. `P5_EVENT_TYPES` lists the intended event names.
- **Not implemented:** event validation/emission, journal projection, idempotency keys, startup recovery ordering, workspace reservation projection, retention lifecycle, eligibility invalidation, or persisted/independently verifiable handoff. No SQL migration was added.

### P5.6 — E2E and regression

- Five focused P5 unit tests were added. The combined P5 + existing P4 workflow Judge run passes 19 tests.
- No Rust Host or P5 E2E suite was added. The 18 acceptance scenarios and C01–C15 crash boundaries remain unimplemented and unrun.

### Changed and added files

- Changed: `docs/schemas/workflow.schema.json`; `runtime/core/{engine,linkedRepair,schemas,validate}.mjs`; `src/{Inspector,model,nodes,types}`.
- Added: `docs/schemas/protected-self-repair.schema.json`; `runtime/core/protectedSelfRepair.mjs`; `runtime/tests/protected-self-repair.test.mjs`; this report.
- Updated pre-existing untracked file `docs/reviews/2026-10-28-p5-protected-self-repair-architecture.md` to define canonical verification command, input, subject-closure, execution-tree, observation-set and check-set digest formulas used by helper contracts.
- No Rust Host, Custody, Store schema, P1, `workflowJudge.mjs`, or migration source was changed. No new journal event behavior is wired.
- Runtime capability discovery does not advertise P5. The UI can author the shape, but the current runtime correctly refuses it.

## D. Candidate identity evidence

The unit test verifies the canonical formula shapes for a synthetic source tree, baseline ID and candidate ID, and verifies that changing candidate bytes changes the candidate identity. The synthetic capture test stores fixture bytes and checks the derived add/modify/delete manifest and scope refusal.

This is not an enrolled source baseline or an accepted candidate. No real P2 link, Parent/Repair publication identity, P3 incident, source release provenance, registered workspace allocation, Developer Attempt, or journal cursor was bound in an Engine transaction. No original-checkout preservation E2E was performed. Candidate drift after acceptance is not integrated with any lifecycle transition.

## E. Verification evidence

**No trusted verification proof exists.** No candidate code was executed by a trusted harness. No baseline B versus broken candidate C negative proof was run. No test proved module resolution selected candidate production code. No verification receipt was issued, so there are no passing required checks, tool closure, Host spool or terminal-tree evidence to report.

The Gate currently has zero inputs and rejects at dispatch. The helper `verifyP5Receipt` is not connected to an Engine-owned transaction and does not constitute a receipt issuer. There was no Engine A→B verifier reattachment and no real Rust Host-backed Gate invocation.

## F. Acceptance evidence

There is no P5 Repair Judge decision, delivered dossier, candidate/receipt binding, atomic P2 P5 approval, retained accepted candidate, or handoff. P5 Stop invalidation and P6 eligibility are not implemented. The current guards prevent P5 direct-start/P2 fallback; ordinary non-P5 P4 behavior was exercised by the targeted legacy test suite.

The handoff helper encodes false values for source application, Git publication, production build, installation and activation, but no handoff was minted or tested against hostile output. This does not satisfy P5-E2E-18.

## G. Recovery boundary matrix

No C01–C15 recovery selector or crash harness exists. Every boundary is **NOT RUN**; the identified recovery behavior remains unimplemented.

| ID | Boundary | Result |
|---|---|---|
| C01 | Authorized Repair before workspace preparation | NOT RUN — no durable preparation intent/projection |
| C02 | Partial preparation before Developer | NOT RUN — no safe materialization recovery |
| C03 | Developer live during Engine exit | NOT RUN — no P5 Developer lifecycle binding |
| C04 | Developer ended before candidate capture | NOT RUN — no transactional capture recovery |
| C05 | Candidate captured before verification | NOT RUN — no candidate journal transition |
| C06 | Verification Gate live during Engine exit | NOT RUN — no asynchronous Host-backed Gate |
| C07 | Gate finished before receipt persistence | NOT RUN — no receipt reconciliation |
| C08 | Receipt committed before Judge admission | NOT RUN — no receipt admission path |
| C09 | Judge live during Engine exit | NOT RUN — no P5-specific dossier/recovery lineage |
| C10 | Judge accepted before P2 reconciliation | NOT RUN — no extended atomic acceptance |
| C11 | Parent Stop during verification | NOT RUN — no verification Stop binding/invalidation |
| C12 | Source mutation after verification | NOT RUN — no acceptance-time recheck |
| C13 | Host unavailable / process termination uncertain | NOT RUN — no Gate holds or uncertainty path |
| C14 | Repeated Engine startup | NOT RUN — no P5 projection/idempotency |
| C15 | Accepted candidate awaiting P6 | NOT RUN — no persisted eligibility/handoff |

## H. E2E matrix

There are no P5 E2E selectors; each case below is **NOT RUN as E2E**. Related unit/legacy evidence is noted without upgrading the case to a pass.

| Scenario | Required harness | Selector / result | Verified source identity |
|---|---|---|---|
| P5-E2E-01 Pinned baseline | F/W/N | None — NOT RUN | None |
| P5-E2E-02 Original source preservation | F/H | None — NOT RUN | None |
| P5-E2E-03 Actual change manifest | D/F | None — NOT RUN; synthetic add/modify/delete unit only (`protected-self-repair.test.mjs:70`) | Fixture only |
| P5-E2E-04 Scope and path refusal | F/W/N | None — NOT RUN; portable path subset unit only (`protected-self-repair.test.mjs:19`, `:57`) | Fixture only |
| P5-E2E-05 Forged verification / B-pass-C-fail | D/F | None — NOT RUN | None |
| P5-E2E-06 Mandatory check failure | D/H | None — NOT RUN | None |
| P5-E2E-07 Exact verified source | D/F/H | None — NOT RUN | None |
| P5-E2E-08 Post-verification mutation | D/F | None — NOT RUN | None |
| P5-E2E-09 Correct Repair Judge | D/N | None — NOT RUN | None |
| P5-E2E-10 Foreign/stale authority | D/N | None — NOT RUN; uninstalled admission refusal only (`protected-self-repair.test.mjs:25`) | None |
| P5-E2E-11 Developer Engine replacement | H | None — NOT RUN | None |
| P5-E2E-12 Gate Engine replacement | H/W | None — NOT RUN | None |
| P5-E2E-13 Parent Stop | D/H | None — NOT RUN | None |
| P5-E2E-14 Uncertain process hold | H/W | None — NOT RUN | None |
| P5-E2E-15 Repeated recovery | D/H | None — NOT RUN | None |
| P5-E2E-16 P6 source identity | F/N | None — NOT RUN | None |
| P5-E2E-17 Legacy compatibility | D | None — NOT RUN as full case; targeted P4 Judge legacy tests passed | No P5 source identity |
| P5-E2E-18 No activation | D/N | None — NOT RUN; helper flags not an injected-output proof | None |

## I. Verification and regression

| Check | Result |
|---|---|
| `node --disable-warning=ExperimentalWarning --test runtime/tests/protected-self-repair.test.mjs runtime/tests/workflow-judge-policy.test.mjs` | Pass, exit 0; 19 tests, 0 failures |
| `npx tsc -b --pretty false` | Pass, exit 0 |
| `npm run docs:check` | Pass, exit 0; 34 schemas, 0 documentation errors |
| `npm run build` | Pass, exit 0; Vite produced a >500 kB chunk warning |
| `git diff --check` | Pass, exit 0 |
| Full `npm test` | NOT RUN; complete P5 focused acceptance and independent implementation blockers were not resolved, so final-source acceptance preconditions were not met |
| `cargo test --manifest-path lifecycle-host/Cargo.toml` | NOT RUN; Host P5 integration and Gate lifecycle were not implemented |
| P5 E2E, C01–C15, native Windows identity, real Host recovery | NOT RUN |

No final full-regression claim is made. The 909/909 P4 result is historical, and this report does not use it as current P5 evidence.

## J. Security and limitations

- No P5 Engine or Host guarantee is enabled. P5 capability validation and P2/Gate guards refuse use without installed enrollment.
- Repository identity records now contain a repository enrollment UUID, canonical common-directory path and native directory ID. No production Git common-directory/native-ID collector is wired; helper callers must supply a current identity value, so this schema and comparison do not establish the checkout identity in the running Engine.
- The candidate inventory detects ordinary topology changes but is not an atomic defense against hostile same-user swap/restore. Windows native identity is not implemented.
- AR01 remains: same-user Full Access code can access user-readable source and control-plane material. No hostile-code sandbox is claimed.
- Current CRLF-transformed checkout is ineligible for byte-identical source enrollment. No checkout normalization was attempted.
- Candidate retention, slot reservation, deferred cleanup, and current handoff eligibility are not implemented.
- P6 build/attestation/activation, P7 triggering and P8 lifecycle work remain out of scope. P5 code added here does not perform Git publication or activation.

## K. Independent review

The existing architecture review concluded **P5 ARCHITECTURE READY FOR IMPLEMENTATION**; it reviewed the design, not this implementation.

A fresh-context read-only implementation review found that the P5 lifecycle remains unimplemented end to end (High), and identified helper-contract gaps. The enrollment validator now checks full publication/profile/policy/workspace/scope/budget/baseline bindings; candidate sealing reads baseline objects, uses manifest-bound exclusions, compares the enrolled workspace identity and requires the exact source root; receipt consistency now verifies the immutable object graph, candidate/source/scope identity, command/input/subject/observation manifests and assertions. The editor Cache/Gate selector and stale-capability issues were also corrected. A follow-up reviewer then identified and this pass fixed the nested repository/P5 enrollment UUID mismatch in admission, candidate sealing and receipt checks. The focused tests cover these helper paths.

The remaining review limitation is the missing production Git common-directory/native identity collector and the absent Engine/Host lifecycle integration. The reviewer did not run tests or builds; verification results in §I are from the recorded commands. No implementation-level “no blockers” or P5 acceptance conclusion is claimed.

## L. Git inventory

- No files were staged. `git diff --cached --stat` was empty.
- No project commits, pushes, merges, rebases, resets or destructive cleanup occurred.
- The pre-existing architecture review was preserved. Historical test evidence was not removed.
- Tracked P4 Judge implementation and Rust Host/Custody sources were not edited. The only P2 source change is the refusal guard for a `selfRepair` profile when P5 enrollment/integration is absent.
- The worktree contains only the P5/schema/editor changes and the existing architecture review plus this report; build output is ignored. Existing CRLF/LF warnings reflect the audited checkout and were not normalized.
