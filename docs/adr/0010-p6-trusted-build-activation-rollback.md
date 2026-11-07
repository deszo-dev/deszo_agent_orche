# ADR-0010: Minimal Autonomous Engine Self-Update

- **Date:** 2026-10-30 (Europe/Moscow)
- **Status:** Proposed
- **Investigation baseline:** `1f54c47fe265c6b47bf36695be56214056fc3af1`
- **Architecture verdict:** P6 minimal architecture ready with limitations; independent read-only review found no unresolved critical, high, or contract-breaking medium design finding. Not implementation or deployment readiness.
- **Scope:** Documentation and architecture only. No P6 production implementation.
- **Current review:** [P6 architecture simplification review](../reviews/2026-10-30-p6-architecture-simplification-review.md)
- **Related decisions:** [ADR-0008](0008-portable-ephemeral-lifecycle-host.md), [ADR-0009](0009-workflow-native-judge-and-exclusive-external-input.md), [P5 closure amendment](../reviews/2026-10-30-p5-closure-architecture-amendment.md). Their statuses are unchanged.

## 1. Context and evidence

P5 produces an accepted `ProtectedSelfRepairHandoff/1` whose Store references identify the accepted source, source and change manifests, verification receipt, Judge decision, P2 acceptance, retention, and current eligibility evidence. P5 acceptance triggers P6. It does not make a stale or invalidated handoff eligible, and it does not authorize Host changes, UI changes, migrations, or arbitrary source execution.

The current Rust Lifecycle Host (H1) cannot perform Engine-only activation with the installed shell unchanged:

- `lifecycle-host/src/lib.rs::verify_build` requires manifest schema 1 and checks the desktop build identity against the selected release.
- `src-tauri/src/main.rs::LifecycleBootstrap::validate` requires the Host-selected application build identity to equal the shell's compiled `DESZO_DESKTOP_BUILD_ID` and requires the running executable's directory to equal the selected application root.
- The Host switches its active pointer to B before B is ready. If B fails, H1 retains B; it has no automatic fallback transaction.
- Engine startup constructs and migrates the Store before Host readiness. The Engine reports ready before the HTTP listener is opened, and H1 treats that report as readiness.
- The Rust Host has no independent P6 admission. Its existing `lifecycle.activate_candidate` accepts an Engine-supplied Judge marker and is not a P6 contract.

These are deployment blockers B1–B4. Existing Rust process control, install locking, artifact hashing, authenticated IPC, readiness identity checks, durable lifecycle state, journal, and Process Custody remain useful. The separate legacy Host service has a rollback helper, but it has a different authority and state owner and cannot be enabled beside the Rust Host. Rust H1 has no P6 fallback.

There is an additional concrete process boundary: Engine shutdown intentionally detaches Process Custody invocations so another Engine can resume them. Before the final switch request, Engine A must settle its work to zero active Custody Jobs. Host then fences new Custody starts and independently rechecks zero before stopping A. If any job remains or is uncertain, Host defers/holds; it does not classify or kill workflow/provider work.

The capability inventory records the implementation evidence and the small remaining compatibility patch. No installed user Host was inspected. H1 is the current repository Host; H-min is the proposed minimal compatibility contract, not an installed capability.

## 2. Decision

After a valid P5 handoff is accepted, the installed Engine automatically:

1. Revalidates the exact handoff, live P5 eligibility, installed baseline, and supported Engine-only scope.
2. Reconstructs the accepted source from immutable P5 Store objects and independently verifies its source and Git identities.
3. Builds and checks the Engine with the currently installed trusted builder.
4. Creates one immutable Engine release package and asks the Lifecycle Host to verify and stage that exact package while A remains selected.
5. Quiesces A and settles its work. A rechecks live P5 eligibility and commits one fixed switch request; Host fences Custody starts, proves zero active Custody Jobs, stops A, and proves the complete managed tree ended.
6. Host guards the production SQLite files and copies the stable database plus any present WAL into bounded Host-owned scratch. It starts B's dedicated read-only preflight against only that disposable copy; B cannot open the production Store before commit.
7. If preflight passes and the guarded production file set remains unchanged, Host atomically commits B, releases the guards, and permits the same B process to continue normal startup. If preflight or staging fails before commit, Host stops B and may restart exact A once only when the production Store and process facts remain unchanged.

There is no new Owner, Judge, grant, approval UI, or per-release permission step between P5 acceptance and activation. The existing installation and one-time P5 enrollment trust model remains the source of authority. P5 acceptance is the trigger; current eligibility, source verification, build verification, Host compatibility, and exact artifact checks remain mandatory.

The current trusted Engine A owns P5 validation, source reconstruction, trusted build orchestration, strict verification of changed control paths, data compatibility analysis, and the fixed switch request. Host owns only its native process and release boundary. Candidate B never verifies itself into activation.

If the Host does not advertise the P6 Engine-switch capability, P6 retains the accepted handoff and any verified build receipt, reports that activation is unsupported, and does not call the H1 legacy activation route. It must not infer support from a version string or successful whole-desktop replacement.

## 3. Supported scope and exclusions

P6 v1 updates only the Node Engine/runtime payload and its matching P5 source payload. The accepted source remains the exact P5 candidate; P6 does not silently select or cherry-pick different files.

The existing release layout can continue to carry the unchanged shell and frozen runtime resources as byte-identical files. They keep their original source/build provenance. The candidate source commit does not become provenance for the copied shell.

P6 v1 refuses activation if the accepted change affects:

- Lifecycle Host, Tauri shell, embedded UI, native shim, Host-facing trust inputs, MCP bridge behavior, Node runtime version, pinned dependencies, or the supported Engine/Host protocol.
- Any Store migration, changed migration digest, new data format, unsupported record contract, or required data conversion.
- Any release whose exact file set or Host/shell compatibility cannot be established.

UI code may remain repairable through P5, but independent UI loading does not exist. A handoff containing UI changes remains accepted evidence and is retained; P6 does not activate a partial Engine-only subset. Host is never updated through Self-Repair. P6 performs no automatic SQLite migration, profile snapshot restoration, or post-commit executable rollback.

Current P5 Host-protection rules continue to apply. The measured shared import closure includes Engine files such as Store and schema modules that P5 currently protects as Host inputs. P6 must not bypass that boundary. Full repairability of overlapping code needs a separate maintainer change to the P5 Host closure.

## 4. Trust and authority boundaries

| Component | Owns | Must not own |
|---|---|---|
| Installed Engine A | P5 handoff validation, current eligibility, source reconstruction, build inputs, fixed builder invocation, candidate checks, final switch request | Selecting active release after it exits; changing Host/shell; interpreting its own candidate as trusted |
| Fixed trusted builder | Deterministic Engine bundle/package production from the exact accepted source and installed pinned tools | Candidate package scripts/config/plugins, Host compilation, credentials, release selection |
| Rust Lifecycle Host | Exact current and staged release identities, switch intent, Process Custody fence, process stop/start, bounded readiness, active selection, pre-write fallback | P3 incidents, Judge decisions, P5 journal or workflow interpretation, source selection, builds, approval policy, general updater |
| Engine B | Read-only P6 startup preflight; after Host commit, normal Engine startup and use of the carried P5 policy | Self-approval, changing the selected release, bypassing preflight or migration restrictions under the accepted cooperative trust model |

The Host checks actual artifact bytes and process identities; it does not independently validate the P5 object graph or rebuild B. That trust has moved to Engine A, which is already trusted by the existing P5 admission model and must verify changed P5/P6 control paths at the existing `repair-authority` floor. The Host still independently verifies the staged package it will launch.

The accepted same-user cooperative boundary remains. Custody Jobs prove owned process lifetime, not an OS sandbox for arbitrary same-user code. P5's in-process assertion limitation and the packaged fault-hook requirement remain explicit implementation risks.

## 5. Automatic pipeline and exact switch boundary

The automatic operation is tied to one P5 handoff and one installed baseline. Only one nonterminal P6 update may exist per installation.

Before the switch boundary, the current Engine rechecks the full handoff graph, current Parent/Repair/link/Stop/invalidation state, P2 acceptance, retention, installed release identity, exact source, strict control-path coverage, supported scope, and Store compatibility. A `blocked` Parent can remain eligible only under the existing captured `failedNodeRetry=never` outcome; a later Stop, invalidation, missing reference, or generic uncertainty blocks P6.

Host accepts a distinct idempotent `stage` command under the P6 operation ID, records phase `staging` before copy, verifies the exact package, then records `staged` while A remains selected. Staging alone has no activation effect. The later `switch` command uses the same operation ID and a distinct command request ID. Engine A checks eligibility again after each long await. It does not add events to the historical P5 Run journal; it uses existing Store artifacts and command receipts.

After staging, Engine A pauses new mutation/dispatch, settles existing work through Run recovery and Custody terminal evidence, and requires zero active Custody Jobs. A's final durable Store transaction rechecks current P5 eligibility and exact baseline, records the immutable staged target, and closes new mutation/dispatch. A committed Parent Stop or P5 invalidation before this transaction blocks the switch. A sends a distinct fixed `switch` command under the same operation ID with the stage receipt, active A identity, package digest, shell identity, and Host generation. Host persists `switching`, fences Custody starts, independently requires zero active Custody Jobs, stops A, and proves process termination before it starts B.

The original proposal to run SQLite `readOnly` against A's live Store was rejected by the Windows feasibility probe. On the tested Node/SQLite build, opening and closing B changed the production `-shm` bytes; a separate writer remained able to write while B was open; and opening a WAL-mode database with missing sidecars created `-wal` and `-shm`. Therefore SQLite's `readOnly` option alone is not the required physical no-write boundary. The probe and machine-readable output are [P6-G0 feasibility evidence](../reviews/evidence/2026-10-31-p6-g0-feasibility.json), generated by [`p6-g0-feasibility-probe.mjs`](../../scripts/p6-g0-feasibility-probe.mjs) and the Rust helper in `lifecycle-host/examples/p6_g0_file_guard_probe.rs`.

After A's managed tree has ended, Host opens the production `state.sqlite` and every present `state.sqlite-wal`, `state.sqlite-shm`, and `state.sqlite-journal` with `CreateFile(GENERIC_READ)` and `FILE_SHARE_READ` only. It captures file identities, content hashes, and the exact Store file set while those handles are held. A present rollback journal or an unsupported/inconsistent SQLite file set fails closed. Host copies the database and any present WAL into an operation-scoped disposable preflight directory; it does not copy a transient SHM file. B opens only the copy using Node SQLite `readOnly`, checks the migration catalog/schema/required read contracts and runs bounded integrity checks. SQLite may create or update WAL/SHM files inside this disposable directory; these are scratch artifacts and are never promoted or restored into the production profile. The same B process closes the scratch connection and waits for Host permission.

Before commit, Host rechecks the held production file identities and digests. The final commit is one durable Host selector update bound to A, B, the stage receipt, preflight process/receipt, snapshot digest, profile, installation, and generation. Host releases the production guards only after recording B as selected and before allowing B's same process to transition to normal runner startup. If staging, snapshot creation, or B preflight fails before commit, Host proves B/Custody trees ended, confirms the production Store file set and bytes stayed unchanged, releases the guards, and may start exact A once. Any uncertainty holds. The disposable copy is validation input only; P6 never uses it to restore or replace production data.

Staging and preflight state survive Host restart as inert pending operation data; Host never switches from those phases alone. If Host or Engine restarts, the same operation and phase receipts are reconciled; changed payloads conflict. A request timeout is not permission to start a different operation.

Before `switch_committed`, Engine A uses existing Run recovery and Custody terminal evidence to settle its work and requires zero active Custody Jobs. If any job or external effect is unresolved, the update waits or holds. After the fixed switch command, Host fences new Custody starts and independently verifies that no Custody Job appeared in the handoff race. The Host never classifies or kills workflow/provider jobs. It gracefully stops A and proves the Tauri/Engine Job and already-terminal Custody Jobs ended before normal B startup. Any nonempty/unknown Job set or uncertain process termination holds the switch. P6 never replays an external effect.

## 6. Stable shell and changing Engine identity

The compatible Host/shell release introduces two independent identities:

- `shellBuildId` and `shellRoot` identify the unchanged Tauri executable and its embedded UI.
- `engineBuildId` and `engineRoot` identify the selected Engine package and its `runtime/runner.mjs`.

The Tauri bootstrap verifies that the actual executable is under `shellRoot` and that `shellBuildId` equals the compiled shell identity. It loads the runner and frozen runtime resources from the separately verified `engineRoot`. The Host verifies that the release manifest binds B to shell S and that copied shell/native/bridge resources match the installed frozen set. Engine readiness reports both identities; Host checks the actual child process, package digest, lifecycle generation, installation, profile, and Store identity.

The existing Host/shell contract has one `buildId` and requires the Tauri executable, release directory, and Engine identity to match. The minimum separately deployed maintainer patch must therefore:

1. Add the shell/Engine identity and root split to the existing Tauri bootstrap and Host release manifest.
2. Add a P6 capability to the current authenticated Host/status protocol. H1's missing capability means no P6 request.
3. Extend the existing Rust lifecycle worker to verify and finalize the exact staged package before stopping A.
4. Persist one pending switch with previous A and candidate B, stop A, guard the production Store, validate a disposable copy with B, then atomically commit B or restore A only if production Store facts remain unchanged.
5. Fence new Process Custody launches and require Engine A to settle all work and reach zero active Custody Jobs before stop; the Host never interprets or kills workflow/provider Jobs.
6. Refuse legacy Engine-accessible `lifecycle.activate_candidate` in a P6-managed desktop installation.
7. Preserve H1 installation state fail-closed. Only the separately authorized maintainer release can perform the Host/shell cutover; it must reject inconsistent or open H1 lifecycle operations.

No new lifecycle service, updater daemon, Store, artifact service, generic policy engine, or Host-side P5 adapter is introduced.

## 7. Durable state and minimal contracts

P6 reuses the existing P5 handoff and immutable source objects, generic Engine Store artifacts and `command_receipts`, the existing `build.json` and resource manifests, the Rust Host lifecycle state/operation file, existing installation lock, `operations.ndjson`, Process Custody, and readiness transport.

The Engine adds one immutable `P6Operation/1` intent and one `P6BuildReceipt/1`. The build receipt binds the P5 handoff/source identity, baseline release, exact trusted build inputs/tools, strict control-path check result, final Engine package digest, and reproducibility result. Each operation's progress is recorded as immutable responses in existing `command_receipts`; there is no mutable P6 phase head, SQL migration, or separate database.

`build.json` moves to schema 2 for P6 Engine packages and separates `engineBuildId` from `shellBuildId`. Its `files` array covers payload files only; the actual package is that exact set plus `build.json`. The Host hashes `build.json` separately, and the build receipt/request bind its digest and the whole-package digest to avoid a self-hash cycle. It reuses existing source, resource, P5 support, and artifact fields. H1 accepts only schema 1 and remains unable to activate the new package.

The installation-wide `.deszo-host/active.json` is the sole authoritative durable selector for the committed release. One atomic record contains the committed `buildId`, `digest`, `generation`, and (upon commit) the `committedOperationId`. Staging never modifies `active.json`; atomic replacement of `active.json` is the single commit boundary.

Authoritative durable state for pending Engine operations and recovery resides in the profile's `.deszo-host/profiles/<profile>/lifecycle.json` under `engineOperation`. This record binds the operation ID, request fingerprint, from/to build IDs, package SHA-256, shell build ID, lifecycle generations, phase, Store guards evidence, preflight report, activation receipt, unproven termination, held-from phase, and stopping instance facts. A pending operation in `lifecycle.json` cannot independently activate another release. The Host operations journal (`.deszo-host/operations.ndjson`) provides durable append-only event evidence (`engine_staged`, `engine_switch_accepted`, `engine_preflight_passed`, `engine_store_boundary_verified`, `engine_switch_committed`, `engine_switch_verified`, `engine_switch_held`, `engine_stage_abandoned`, `engine_stage_superseded`).

During restart reconciliation, `active.json` is the commit authority: a candidate is committed only if `active.json` records `committedOperationId == operation.operationId`. If `active.json` does not confirm commit, pending phases (`staging`, `staged`, `fenced`, `a_stopped`, `guarded`, `preflight_running`, `preflight_passed`, `committing`, `fallback`) reconcile safely: incomplete operations are abandoned or rolled back to Engine A without Store modification; unproven terminations hold fail-closed. An operation already committed in `active.json` cannot be rolled back by a stale pending phase. The Host installation lock prevents another Host from acting on the same desktop installation.

The Host can safely reuse its active file and operation record instead of a second database. It may not rebuild selection by scanning version folders or trusting an Engine Store projection. If the authoritative Host record is corrupt or disagrees with a release, the Host holds and does not start another Engine.

## 8. Startup, readiness, state compatibility, and fallback

The current Engine checks Store schema and migration history before requesting a switch. Candidate B is built and checked against the current supported Engine/Store reader contract. P6 v1 requires the same migration catalog and data format as the installed profile; no migration may be required.

B is launched in a dedicated P6 preflight entrypoint only after A is stopped and Host proves the managed process tree ended. The entrypoint runs before the normal runner path, so it must not create profile runtime directories or Owner tokens, construct the normal Store, run migrations/backfills/recovery, start the normal HTTP API, launch providers, resume Runs, or acknowledge user work. Host acquires native read-only guards over the production SQLite files and rejects a hot rollback journal or ambiguous file set. It copies `state.sqlite` and any WAL to a Host-owned disposable scratch directory, omitting transient SHM, and verifies the copy against the guarded file inventory. B uses the pinned Node SQLite `readOnly` open only against that copy to check the installed migration catalog and actual profile schema/read contracts. SQLite may create scratch sidecars; they are discarded. A missing/unreadable required file, unsupported SQLite mode, identity/hash mismatch, or any guard/copy error fails closed.

After preflight succeeds, B closes its scratch SQLite connection and remains alive in a maintenance wait state over the existing Host channel; it has no normal API or workload. The same B process identity stays bound to the staged package. Host keeps the production file guards while B waits. The P6-preflight result travels over the existing authenticated Host channel and binds actual B process, shell/package, installation, profile, scratch Store, and generation. It is a compatibility gate, not normal Engine/API readiness. On commit, the Host atomically selects B, releases the production guards, and permits that same process to enter the normal runner and production Store path. If B fails before commit, Host proves the managed B tree ended and confirms the original production Store inventory/content is unchanged before one exact A fallback. Otherwise it holds. Host restart recovery must reacquire guards and reconcile the same copy/operation; if the original files changed or cannot be identified exactly, it holds rather than falling back.

Only after Host commit may the normal runner, production Store constructor, recovery, API, or workload begin. Host releases the production file guards at this boundary. A failure during normal postcommit startup leaves B selected and requires ordinary/manual recovery; P6 does not automatically start A after the write-capable boundary. A later failure cannot be compensated by executable fallback or by undoing external effects.

Precommit readiness is limited to read-only schema/migration/data-format checks on the disposable copy, bounded integrity/read-contract checks, the existing authenticated Host channel, and actual process, shell, Engine/package, generation, installation, profile, Store-file, and copy identities. The regular API-ready response happens after commit and is health evidence, not fallback authority. This is not a general probation service and does not use model calls or treat a candidate success string as authority. The preflight copy is not a database restore point and cannot become production data. The same-user trust boundary still applies to unrelated profile files and arbitrary non-Host writers.

## 9. P5 continuity without recurring approval

The installation-owned `profile/p5/enrollment.json` remains the immutable root of the Owner's existing P5 enrollment. P6 does not rewrite it and does not ask the Owner to repeat enrollment after every Engine update.

Before staging, trusted Engine A prepares the successor baseline, Host-attested running-source artifact, verification-policy artifact, and P5 profile artifact from the exact accepted handoff using existing P5 schemas. The successor policy preserves the root policy's required checks and bounds while binding B's new P5 control/input closure. The successor profile preserves the Owner-installed workspace, scope, budgets, repository identity, and Parent/Repair publication refs; only source/release-bound baseline and policy-closure refs advance. `P6BuildReceipt/1` binds that successor P5 profile to B's exact package.

After Host commits B, it durably retains and returns the activation receipt to B, including after Host restart. After the normal Store opens without a migration, but before P5 admission or Engine recovery, B records an idempotent P6 continuation step linking the unchanged enrollment root, accepted handoff, build receipt, Host activation receipt, and prepared successor P5 profile. The P5 reader extension validates the immutable root enrollment file as written, follows the unique P6 progress chain, and derives an effective enrollment using the Host-attested successor profile. It verifies all non-release policy/workspace/scope/budget/publication fields against the root and requires the current Host-attested package/source release to match the successor profile exactly. If the receipt or continuation write is missing or mismatched, P5 admission remains closed; a later B startup replays the same Host receipt. The root file and Owner's policy remain unchanged, and no per-update re-enrollment or generic credential delegation is introduced.

This is a narrow P5 reader continuation rule, not a grant or authorization chain. It cannot select a new Repair source, widen scope, change budgets, or revive a stopped Parent. If the chain is missing, forks, contains a failed/held operation, or does not match the active Host release, P5 admission remains closed. The next P5 repair may proceed only after B verifies this continuation. Each later accepted update extends the same linear chain, so autonomous Self-Repair continues beyond the first successful Engine update without recurring Owner approval.

## 10. Verification and accepted limits

The fixed builder reconstructs source only from the accepted P5 Store objects and verifies their Git commit/tree/blob/mode identities. It uses the existing low-level bundle, inventory, and packaging routines through a trusted Store-input adapter; the current high-level desktop packager requires a clean Git checkout and cannot be called unchanged on reconstructed Store bytes.

The installed builder, parser, Node/esbuild tools, options, lock/dependency closure, and frozen resource identity are fixed installed inputs. Candidate package scripts, config, plugins, toolchain changes, or model-selected commands do not run. Build twice from separate materializations and compare exact Engine bundle/package identities. `build.json.files` lists payload files only; the actual package contains exactly that set plus `build.json`. Host hashes the manifest separately, while `manifestSha256` and the whole-package digest are bound outside it by the build receipt and fixed Host request. This avoids a self-hash cycle. Host also verifies frozen shell/resource copies. Hash verification proves byte identity, not independent compilation.

Changed Engine P5/P6/control imports must receive the existing P5 `repair-authority` strict verification floor, derived from the effective baseline and candidate bundle closure. Missing coverage, dynamic/unresolved imports, Host/shell impact, unsupported source, build failure, or uncertain source/Store evidence blocks activation; P6 does not automatically launch another Repair.

Known limits are accepted and visible:

- H1 remains unsupported until the separate H-min Host/shell capability is deployed. A handoff bound to a pre-cutover H1 baseline cannot be relabeled for H-min; after the separately authorized maintainer cutover, the first compatible Engine baseline must already include the P6 consumer and P5 continuation reader, and initial P5 enrollment/handoff must bind that baseline once.
- The Host does not independently verify P5 or rebuild B. Trust in candidate admission rests with the current installed Engine and the current P5 control-path verification floor.
- The unchanged Tauri shell has no external UI loader; UI updates and automatic migrations are unsupported.
- Exact fallback is only before Host commit and the normal write-capable runner. A normal Engine/API startup failure after Host commit leaves B selected; process uncertainty or observed Store drift holds; the preflight copy is never restored.
- The live-Store read-only model was rejected by the focused Windows feasibility probe: it changed `-shm`, did not exclude a second writer, and created absent sidecars. A native file guard blocked write/delete/rename but could not be acquired while A still held SQLite open. The post-stop guarded disposable-copy design is the required path. Operation-scoped production integration, all WAL/journal cases, Host restart reacquisition, and packaged Host/B handoff remain implementation proof obligations.
- Normal Engine/API startup happens after Host commit, so a failure there is not automatically rolled back. This preserves Store certainty at the cost of requiring ordinary/manual recovery for that failure class.
- Existing P5 Host-protection overlap limits which shared Engine source files can be accepted for update until a maintainer separates those closures.
- P5's same-user process model is cooperative, not an OS sandbox. The current environment-gated P5 fault hooks must be made inert in packaged source and bundles before a production P6 build can rely on them.
- No installed Windows H-min proof exists yet. Readiness and fallback remain implementation proof obligations.

## 11. Implementation order

1. **Minimal Host compatibility patch:** separately authorize and deploy the Host/Tauri bootstrap identity split, exact package verification, single durable switch record, zero-Custody fence, dedicated preflight readiness, precommit fallback, and legacy-route refusal. H1 refuses.
2. **Automatic trusted build from P5:** add the installed Engine P6 consumer and Store-source builder; verify exact handoff, control closure, tools, output, and receipt. No Owner P6 grant.
3. **Engine-only switching and continuity:** wire the fixed request, read-only B preflight, exact Host commit/fallback, and linear P5 continuation to the existing receipts.
4. **Real Windows desktop E2E and regression:** test the actual Rust Host, Tauri shell, Engine packages, SQLite profile, Custody jobs, repeated restart, fault boundaries, legacy bypasses, and P5 continuation. No production deployment until evidence meets the acceptance contract.

ADR acceptance remains separate from implementation readiness. This task performs no P6 production implementation.

## 12. Decision delta from the earlier Proposed ADR-0010

| Earlier proposed decision | Revised decision |
|---|---|
| Owner grants separately authorize each build and activation | No new Owner approval after an eligible accepted P5 handoff |
| Selected authorization heads, grant/revoke records, and authority seals | Remove; existing P5 enrollment/eligibility plus Host/Engine identities are sufficient for this bounded operation |
| H2 comprehensive Host lifecycle/probation architecture | Reuse Rust Host and add only identity split, exact switch state, Custody fence, readiness, and fallback |
| Host-side P5/P6 Store admission adapter | Current Engine A verifies P5; Host verifies only exact release and process identity |
| Extensive probation and multiple launch-purpose grants | One bounded read-only preflight before B commit; no normal workload before commit |
| Extensive administrative API and approval UI | No new API/approval flow; reuse P5 handoff trigger and read-only status |
| Multiple selected revision heads and revocation chain | Remove; one immutable operation per handoff, exact current eligibility checks, one Host operation |
| Manual re-enrollment after every Engine update | Preserve immutable root enrollment and advance via verified P6 continuation receipts |
| No migrations and Host immutability | Preserve |
| Engine-only initial update boundary; UI unsupported | Preserve |
| Store snapshot restoration excluded | Preserve |
| Exact P5 handoff and trusted build | Preserve |

## 13. Revision history

| Date | Revision |
|---|---|
| 2026-10-30 | Initial Proposed ADR-0010: P6 trusted build, two Owner approvals per release, selected authorization heads, and comprehensive H2 admission/probation/rollback contracts. |
| 2026-10-30 | Owner-directed simplification: automatic build and activation from eligible P5 acceptance; remove per-release approval/grant architecture; keep the Host narrow; split shell and Engine identities; retain only process-safe pre-write fallback. |
| 2026-11-01 | P6-G0 implementation note, no decision change: the switch trigger is a G0 test route, present only in test-marked packages; the production trigger is the P5 handoff path that P6-BUILD adds, with no Owner approval after an eligible accepted P5 handoff (section 12). The pending operation is recorded in `lifecycle.json` (section 7 note). Evidence: `docs/reviews/2026-11-01-p6-g0-completion.md` and `docs/reviews/2026-11-01-p6-g0-final-acceptance.md`. |
| 2026-11-02 | P6-G0-CLOSE contract reconciliation: ADR-0010 aligned with actual Host state persistence. `.deszo-host/active.json` is the authoritative committed selector; profile `lifecycle.json` holds durable pending operation and recovery state; `operations.ndjson` records durable event audit. Stage-abandon path verified by native regression test. Precommit logging bounded outside Store state. |

