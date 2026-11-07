# P6 Minimal Architecture — Implementation Plan

Date: 2026-10-30. Baseline: `1f54c47fe265c6b47bf36695be56214056fc3af1`. Status: proposed sequence only.

This architecture task changes documentation only. It does not authorize or perform the P6 production implementation below. Current H1 remains fail-closed and unsupported.

## 1. Stage 1 — Minimal separately deployed Host/shell compatibility patch

Implement, review, and deploy a maintainer-owned Host/shell release separately from Self-Repair. Reuse the current Rust lifecycle framework, install lock, process Jobs, IPC, active selector, operation journal, staging/version directories, and Process Custody.

Required work:

- Separate stable `shellBuildId/shellRoot` from changing `engineBuildId/engineRoot` across Rust Host launch, `build.json` schema 2, Tauri bootstrap, and Engine readiness.
- Verify and finalize the full immutable Engine package and frozen shell/native/bridge resources before stopping A.
- Extend existing Host state into one authoritative installation-wide selector with one pending P6 operation. Record exact A/B identities, durable `staging` and `staged` phases, preflight/switch phases, process identities, and one-shot B/A launch facts. A remains selected through staging and preflight.
- Require Engine A to quiesce work to zero active Custody Jobs before final commit; Host fences new starts and independently confirms zero. Host does not classify or kill workflow/provider jobs. It proves A's Tauri/Engine Job ended before B's normal startup.
- Fence Custody, stop A, and prove its managed process tree ended before B preflight. Hold native read-only guards over the production DB and present sidecars, reject a hot rollback journal or ambiguous file set, and copy the main DB plus any WAL to disposable Host scratch. Start B's dedicated read-only preflight only against scratch, before normal runner writes, Store construction, migrations, recovery, or API. B closes the scratch handle and waits in the same process for Host permission. Commit B only after authenticated preflight and exact process, shell, Engine, package, generation, profile, and Store identity checks.
- Permit one fallback to A only before Host commits B, after proving B and its process tree ended and the guarded production Store inventory/content is unchanged. If any state is uncertain, hold. After Host commit and guard release, normal Engine/API startup failure leaves B selected for ordinary/manual recovery.
- Refuse legacy `lifecycle.activate_candidate` in P6-managed desktop installations. Advertise a P6 capability absent from H1.
- Fail closed on H1 state or release ambiguity during the separately authorized cutover. No P6 path updates Host or shell.

Required evidence: real Windows Host/Tauri process test; A-shell/B-Engine distinct roots and IDs; exact package file-set/hash comparison with `build.json` excluded from its own file list and separately hashed; guarded DB/WAL copy and scratch-only SQLite preflight; B failure allows one exact A fallback only after A has stopped and the production Store is proven unchanged; postcommit API failure leaves B selected; Host restart and legacy bypass tests; no two active Engine workloads or active Custody job at B startup.

Stop if B still must use the shell build ID as its Engine ID, if Host state can select two releases, if Custody work can survive the switch without proof, or if a new P6 database/supervisor is needed.

## 2. Stage 2 — Automatic trusted build from accepted P5 handoff

Add one Engine-owned P6 consumer that starts on P5 acceptance. It revalidates the actual current handoff and eligibility, reconstructs exact Store source/Git objects, and uses the current installed trusted builder. It records one `P6Operation/1` and one `P6BuildReceipt/1` through existing Store objects and command receipts.

Required work:

- Verify current Parent/Repair/link/Stop/invalidation state, P2/P4 acceptance, retention, source/Git identity, and exact installed baseline before build and after every long await.
- Reject unsupported Host, shell, UI, bridge, dependency, native, or migration changes without cherry-picking. Retain the accepted handoff.
- Derive the trusted Engine control closure and enforce the existing `repair-authority` floor for changed P5/P6 inputs.
- Adapt fixed low-level package/bundle routines to exact Store source. Do not call the clean-Git-only packager unchanged.
- Pin builder code, Node/esbuild tools, options, dependencies, resources, and environment. Do not execute candidate scripts/plugins/configuration.
- Build twice from separate source materializations and compare exact bytes/manifests. Bind the complete result in the Store receipt.
- Prepare the successor P5 baseline, running-source artifact, verification-policy artifact, and P5 profile from the accepted source using existing schemas. Keep the root policy's checks/bounds and all workspace/scope/budget/repository/publication fields unchanged; advance only exact release/source/control-closure references.
- If H1 lacks P6 capability, retain the build receipt and accepted source without calling legacy activation.

Deployment prerequisite: the first compatible maintainer Engine baseline must already contain the P6 consumer and P5 continuation reader; the initial enrollment/handoff is created once against that exact Host/Engine baseline. Thereafter accepted eligible handoffs update automatically.

Required evidence: immutable handoff reconstruction; wrong/stale-ref refusal; changed trusted-closure floor; two-root reproducibility; tool/output identity; no candidate-controlled build authority; no repeat builder while an earlier Custody invocation may be live.

## 3. Stage 3 — Engine-only switch, fallback, and P5 continuity

After Host has durably staged the exact package, Engine A pauses new mutation/dispatch, settles existing work through current Run/Custody machinery, and waits for zero active Custody Jobs. Host fences new Custody starts, stops A, and proves its managed process tree ended. It acquires native file guards over the production SQLite files, rejects hot journals/ambiguous sidecars, and copies the DB plus any WAL to disposable scratch. Host launches B's maintenance preflight only against scratch; B remains alive in the same process waiting for commit. A nonzero/unknown Custody set defers or holds without Host-side job classification or termination. Staging/preflight alone never changes the selected release.

Required work:

- Settle Engine/Custody work using existing Run recovery and native terminal evidence; do not ask Host to classify or kill provider jobs. Hold/defer while any Custody job or external effect is unresolved.
- Ensure Host intent is durable before stopping A; one operation may name only one exact B and the recorded A fallback.
- Ensure B uses a dedicated preflight entrypoint before the normal runner path; it cannot write runtime files, construct Store, migrate, recover, start providers/API, or mutate user data. Host commit is the only release into normal startup.
- Make Host choose B only after bounded read-only preflight. Fallback to A only before B commit, after proving B/Custody ended and the profile is unchanged. Postcommit API/Engine startup failure keeps B selected.
- Preserve every accepted work item, existing P5/P2 history, and no-replay semantics; do not restore a Store snapshot.
- The first compatible baseline must already include the P6 consumer and continuation reader. Host retains its activation receipt across restart. Before P5 admission or normal recovery, B idempotently records the Host receipt and carries the existing immutable P5 enrollment forward through a complete linear chain of P5 handoffs, P6 build receipts, Host activation receipts, and successor source baselines. Do not prompt for re-enrollment for each Engine update.
- Extend the P5 reader to validate the unchanged root enrollment, follow the unique P6 receipt chain, and derive an effective enrollment from A's prepared successor P5 profile only when Host attests the matching B package. Missing/forked/mismatched links keep P5 closed.
- Keep post-commit A rollback unsupported. A migration, Store drift, unknown process, or incompatible reader blocks fallback.

Required evidence: exact final-boundary Stop/invalidation race; Host lost reply and Host crash recovery; B preflight failure before commit with safe A fallback; B Store drift causing hold; postcommit normal API failure keeping B selected; existing P5 continuation through two successive Engine updates with no repeat Owner approval; no legacy route.

## 4. Stage 4 — Real Windows desktop E2E and regression

Use a test-owned installation, profile, repository, real SQLite/Store, actual release Rust Host, actual stable Tauri shell, actual Engine bundle, and native Process Custody. Begin with a compatible enrolled A and a normal P3→P4→P2→P5 accepted handoff. Do not inject a test handoff as an installation authority.

Run the full C01–C18 recovery matrix, including:

- Engine death during and after build; incomplete output and stage.
- Changed candidate bytes after verification.
- A shutdown failure; Host crash after stopping A and after recording B pending.
- B preflight failure after A stops; Host verifies the guarded production Store is unchanged, performs at most one exact A fallback, or holds on any uncertainty.
- B exit after A stops but before Host commit; exact A fallback only with unchanged post-A-shutdown Store.
- Postcommit normal API failure; B remains selected and no A fallback occurs.
- Host crash during fallback; uncertain A/B process state holds.
- B Store/schema drift during preflight; A remains active. Drift after A stops holds unless exact post-shutdown state still matches; postcommit API failure leaves B selected.
- Repeated Host restart and concurrent switch requests.
- Stop/invalidation before the final Engine transaction; exact fixed-target recovery after it.
- Two P6 Engine updates in sequence, preserving the original Owner-installed P5 policy and exact source baseline chain.
- Legacy activation bypass, UI/bridge/native changes, unsupported migrations, R14 environment fault hooks, and no P5 Host-boundary weakening.

Acceptance evidence: package/source/tool digests; Host selector and operation history; native Job identities and terminal proofs; shell/Engine split identities; profile Store/schema facts before and after; single P6 activation or safe A fallback receipt; P5 continuation refs; preserved acknowledged work and external effect certainty.

A passing helper test is not an installed desktop proof. Do not reuse historical P5 totals as P6 evidence. Run focused and full project-required checks on the final frozen implementation snapshot, then obtain a fresh-context read-only implementation review. Resolve all Critical, High, and contract-breaking Medium findings before marking implementation complete.

## 5. Architecture-task boundary

This document revision does not run Rust, Node, Tauri, installed application, production profile, or P6 E2E tests. Those remain future implementation evidence. No P6 production source/schema, Host executable, shell, or user installation may be changed as part of this architecture task.

Current H1 remains unsupported. A P5 handoff bound to H1 is not relabeled after a Host/shell cutover. The separately authorized maintainer release establishes the first compatible Host/Engine baseline, and that Engine must already contain the P6 consumer and P5 continuation reader. The original enrollment/handoff is then created once for that baseline. Later accepted Engine Self-Repair updates proceed automatically under the verified P5 continuation chain.

The P6 packet consists of [ADR-0010](../adr/0010-p6-trusted-build-activation-rollback.md), [contracts](2026-10-30-p6-contracts.md), [capability inventory](2026-10-30-p6-existing-capabilities.md), [recovery matrix](2026-10-30-p6-recovery-matrix.md), and [architecture simplification review](2026-10-30-p6-architecture-simplification-review.md). The ADR and all proposals remain Proposed until the project's decision process accepts them.

