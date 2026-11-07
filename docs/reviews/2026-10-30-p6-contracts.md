# P6 Minimal Architecture — Contracts

Date: 2026-10-30. Baseline: `1f54c47fe265c6b47bf36695be56214056fc3af1`.  
Parent: [ADR-0010](../adr/0010-p6-trusted-build-activation-rollback.md).

These are proposed P6 contracts, not production schemas or current Host capabilities. No production schema, migration, Host, or Engine code was changed. H1 does not support any P6 activation command.

## 1. Existing identities and source authority

P6 consumes the existing `protected-self-repair.schema.json` `handoff` definition unchanged. The current managed-clone handoff carries the actual P5 fields:

```text
schemaVersion, kind, handoffId, candidateId, candidateSourceDigest,
candidate, gitCandidate, baselineId, repositoryIdentity, sourceBinding,
enrollment, sourceManifest, changeManifest, verificationPolicy,
verificationInputs, verificationReceipt, parentRunId, repairRunId,
linkId, incidentId, judgeAttemptId, decisionId, p2Authorization,
p2Approval, p2Outcome, retentionRecord, continuationState,
hostProvenance, retention, currentEligibility, authority
```

P6 v1 requires the managed-clone source/Git identity supported by the current P5 closure. It verifies every reference against the existing Store, validates the unique handoff journal membership and lineage, recomputes the accepted source digest, checks Git commit/tree/blob/mode identity, verifies the causal P5 receipt and P4/P2 acceptance, and reads current Parent/Repair/link/Stop/invalidation state. Acceptance-time `currentEligibility` is evidence, not a live authority. Any later Stop, invalidation, generic block, missing object, unsupported version, or stale baseline blocks the switch.

The current Engine uses its installed P5 implementation and installed protected check policy. It derives the effective baseline/candidate control import closure from actual packaging resolution. Changed reachable P5/P6/control code must have existing `repair-authority` checks. Missing strict coverage, unresolved/dynamic imports, or candidate-controlled verification authority blocks P6. P6 does not weaken P5's Host boundary or automatically start a second Repair.

The accepted handoff and its source digest remain the source identity. The Engine release inventory and package digest are derived artifact identities; they do not replace or rewrite the P5 source subject.

## 2. Minimum durable records

P6 uses the existing P5 object graph, Engine Store artifacts and `command_receipts`, `build.json` and resource manifests, Host lifecycle state, `operations.ndjson`, and Process Custody. It introduces only one Engine receipt type and one bounded operation projection; no SQL migration or separate P6 store is required.

| Record | Owner and required fields | Why durable / existing schema reused | Failure if omitted |
|---|---|---|---|
| `P6Operation/1` | Engine A. Immutable operation intent: `operationId`, exact handoff ref/hash, exact installed Engine/shell baseline identity, fixed candidate identity, original enrollment root ref, creation time. | One immutable intent artifact in generic Store object storage. Progress lives only in existing per-command `command_receipts`; no mutable P6 row or phase head is added. | Engine restart could lose which exact P5 handoff/baseline is in flight or accept a second target for the same operation. |
| `P6BuildReceipt/1` | Installed trusted builder, recorded by Engine A. Exact handoff/candidate/source/Git refs and digests; baseline release identity; fixed builder/tool/dependency identities; strict control-closure result; successor P5 profile ref; manifest/package digests and file set; two-build byte equality. | Immutable generic Store artifact; derived from existing P5 source objects, current Owner policy, and existing package/resource manifests. Receipt is outside the release package to avoid a hash cycle. | A later Engine could not prove which source/tools produced B, the P5 continuation prepared by trusted A, or whether B is an incomplete/changed build. |
| `build.json` schema 2 | Trusted packager generates; Host verifies. `engineBuildId`, `shellBuildId`, runtime API/Node compatibility, exact source/input provenance, P5 support/resource refs, and every payload file path/hash/size. The manifest itself is separately hashed and package-bound. | Extends the existing release manifest. H1 accepts schema 1 only and therefore fails closed. No second manifest is created. | Host could not distinguish B from S or prove the exact bytes and frozen resources it will launch. |
| Host active selection / switch operation | Rust Host. Authoritative committed Engine release in `.deszo-host/active.json` (`buildId`, `digest`, `generation`, optional `committedOperationId`). Authoritative pending operation and recovery state in profile `lifecycle.json` (`engineOperation`: previous A and candidate B identities, phase, store guards evidence, preflight report, receipt, termination proof, stopping instance). Operations journal `operations.ndjson` records durable event audit. | Extends existing installation-wide `active.json` selector and Rust Host profile lifecycle/audit state. `active.json` is the sole commit authority; `lifecycle.json` cannot independently select another release. | Host restart could select a directory by scanning, start B twice, lose A fallback, or disagree with the actual installed release. |

Shapes below are closed, versioned documentation contracts. Real production schemas must be added only during implementation.

```ts
type Ref = { artifactId: Uuid; sha256: Sha256 };
type ReleaseIdentity = {
  engineBuildId: BuildId;
  enginePackageSha256: Sha256;
  manifestSha256: Sha256;
  sourceCommit: GitOid;
  sourceDigest: Sha256;
  inputsDigest: Sha256;
  shellBuildId: BuildId;
  shellSha256: Sha256;
  frozenResourcesDigest: Sha256;
};

type P6Operation = {
  kind: 'P6Operation'; schemaVersion: 1;
  operationId: Uuid;
  handoff: Ref; handoffId: Sha256; candidateId: Sha256;
  candidateSourceDigest: Sha256;
  previousRelease: ReleaseIdentity;
  enrollmentRoot: Ref;
  createdAt: IsoTime;
};

// Stored as an existing command_receipts response artifact, not a new SQL table.
type P6Progress = {
  operation: Ref;
  requestId: Uuid;
  phase: 'accepted' | 'building' | 'built' | 'staged' | 'preflight_ready' | 'switch_committed'
       | 'activated' | 'restored_previous' | 'blocked_host' | 'failed' | 'held_uncertain';
  predecessor: Ref | null;
  buildReceipt: Ref | null;
  candidateRelease: ReleaseIdentity | null;
  hostOperationId: Uuid | null;
  hostStageReceipt: Ref | null;
  preflightReceipt: Ref | null;
  hostReceipt: Ref | null;
  successorP5Profile: Ref | null;
};

type P6BuildReceipt = {
  kind: 'P6BuildReceipt'; schemaVersion: 1;
  operationId: Uuid; handoff: Ref; handoffId: Sha256;
  candidate: Ref; gitCandidate: Ref;
  candidateSourceDigest: Sha256; sourceCommit: GitOid; sourceTree: GitOid;
  previousRelease: ReleaseIdentity;
  buildInputDigest: Sha256;
  builderIdentity: Ref; toolAndDependencyClosure: Ref;
  strictControlClosure: Ref;
  successorP5Profile: Ref;
  manifestSha256: Sha256; packageSha256: Sha256;
  files: Array<{ path: RelPath; sha256: Sha256; bytes: number }>;
  reproducedPackageSha256: Sha256;
  reproducible: true;
  recordedAt: IsoTime;
};
```

The `P6Operation/1` intent is immutable. Each progress command uses its own existing `command_receipts.request_id` and stores a `P6Progress` response artifact with the operation ref, phase, predecessor response, and result refs. The Store transaction inserts the response and command receipt together and refuses a second successor for the same predecessor. A retry with the same request ID/payload returns the same response; a different handoff, baseline, or operation target conflicts. Startup derives the current phase from the single validated linear receipt chain; a missing, forked, or conflicting chain holds. This uses the existing command-receipt primary key and transaction rather than mutating one receipt or adding a P6 table. No revision-head graph, grant/revoke record, or additional authorization state is introduced. Build failures and unsupported scope retain the accepted P5 handoff.

## 3. Exact-source trusted build

The current installed Engine, not B, consumes the accepted P5 graph. It revalidates the handoff before building, after long awaits, before Host staging, and at the final switch boundary.

The builder materializes exact P5 Store bytes and modes into owned scratch and independently verifies the accepted Git commit/tree/blob identities. It does not trust a branch name, mutable checkout, build label, model report, or packager stdout. The existing desktop packager requires a clean Git checkout; P6 must use its trusted low-level copy, bundle, inventory, and manifest routines through a fixed Store-input adapter.

P6 uses installed fixed builder code, Node/esbuild binaries, options, dependency closure, resource inventory, and policy. Candidate scripts, package configuration, plugins, npm install, model-selected commands, candidate Host builds, and candidate-supplied verification policy are not executed. Build the Engine twice from separate materializations and compare exact bytes and manifests. The release receipt binds both build results and the final Host package digest. Host hashing establishes exact byte identity; it does not independently compile B.

The candidate package includes a byte-identical copy of the installed Tauri executable and frozen runtime resources where the current layout requires them. Each frozen file retains its original source/build provenance. The candidate source commit is not used as shell provenance.

## 4. Host manifest and artifact verification

H1's schema-1 `build.json` couples desktop and Engine build IDs. The compatible Host/shell patch accepts schema 2 only when all of the following match:

- The manifest's `engineBuildId` equals the staged Engine identity.
- The manifest's `shellBuildId` equals the installed compiled shell identity.
- The shell executable and each frozen native, bridge, and runtime resource hash match the installed baseline.
- Runtime API, Node version, architecture, and Host capability are supported.
- `build.json.files` lists payload files only. The actual package file set must equal that payload list plus the single `build.json` file; unknown, missing, duplicate, aliased, linked, reparse-point, or special paths refuse.
- The Host hashes `build.json` separately and validates its schema and shell/Engine binding. `manifestSha256` and the whole-package digest are bound outside the manifest in the P6 build receipt and fixed switch request, avoiding a self-hash cycle.
- The package digest matches the fixed switch request and the Host's final recheck immediately before launch.

The Host does not validate P5's journal or Judge decision. It accepts only the current authenticated Engine's fixed request under its current lifecycle generation and active A identity. It does not accept a Host-compatible boolean from B.

## 5. Minimal Host operation

The existing Host installation lock prevents two Host instances. P6 uses two internal authenticated commands under the same operation ID, not a public approval endpoint: `stage` has its own command request ID and stores an inert release; `switch` has a distinct request ID and authorizes only the final process transition. A different handoff/target conflicts.

For `stage`, Host persists phase `staging` in the existing installation-wide active-selection record before copy, verifies the exact package, then records `staged`. A remains selected and running; stage presence alone never activates B. Engine A then pauses new mutation/dispatch and settles work through Run recovery and Custody terminal evidence. Any unresolved job or external effect defers the update. Host fences Custody, stops A, and proves its managed process tree ended before it touches the production Store. It acquires native read-only guards on the SQLite files, inventories file identities, and copies `state.sqlite` plus any WAL file into Host-owned disposable scratch. A hot rollback journal or uncertain SQLite file set fails closed. B preflights only this scratch copy; it never opens the production Store. The preflight runs before the normal `runner.mjs` path and must not create profile runtime directories or Owner tokens, construct the normal Store, run migrations/backfills/recovery, start the normal HTTP API, launch providers, resume Runs, or acknowledge user work.

The preflight opens only the disposable Store copy with the pinned Node SQLite `readOnly` option. It checks the copied migration catalog and installed schema/read contracts. Windows experiments showed that a live-store SQLite read-only open changes `-shm`, does not fence a separate writer, and can create missing WAL/SHM sidecars. Therefore B must not open the production Store, and SHM is not copied as durable database content. With A stopped and Host guards held, the Host copies the main DB and any WAL, rejects a present rollback journal or ambiguous pair, and proves production identities/content remain unchanged. Scratch sidecars created by SQLite are allowed and discarded. B closes its scratch connection and stays alive in a maintenance wait state over the authenticated Host channel. Its report binds actual B process, shell/package, installation, profile, scratch Store, and generation identities. It is a compatibility gate, not normal Engine/API readiness.

After successful scratch preflight, A's final Store transaction rechecks current P5 eligibility and records the immutable staged target/preflight receipt before closing Engine mutation/dispatch. Host persists phase `switching`, fences new Custody starts, and independently verifies zero active Custody Jobs. Engine A must already have settled its work; Host never classifies or kills workflow/provider Jobs. If any job is active/uncertain, Host holds without starting B. Otherwise it gracefully shuts down A and proves the Tauri/Engine Job ended. Host records byte/identity facts for the production DB and every present SQLite sidecar, acquires `CreateFile(GENERIC_READ)` handles with `FILE_SHARE_READ` only, then copies the main DB and any WAL into disposable Host scratch while retaining the guards. A hot rollback journal, ambiguous sidecar state, copy mismatch, changed identity, or failed guard holds the switch.

Only after the copied Store passes validation and A is proved ended does one atomic Host record select B and issue normal-start permission to the same B process. Host releases production file guards immediately before B normal startup; B then opens the production Store through the ordinary runner path. If B fails preflight, A has already stopped, so Host proves B/Custody/process trees ended and production Store identities/content still match the preflight baseline before the one exact A fallback. Otherwise it holds. The regular API-ready response arrives after commit and is health evidence only; a post-commit API/Engine startup failure leaves B selected for ordinary/manual recovery. P6 never starts A after the write-capable boundary.

The Host operation phase is one of `staging`, `staged`, `preflighting`, `ready_to_switch`, `switching`, `starting`, `committed`, `restoring_previous`, `restored_previous`, `failed`, or `held_uncertain`. The record stores one B preflight/start and one A fallback limit; replaying an identical command returns history and current observation, never repeats a completed effect. Host restart preserves inert stage/preflight state and never switches from those phases alone. A different operation is refused while one is pending.

The existing `engine.status` may expose bounded P6 status. It remains read-only. There is no general updater API, new background service, Host-owned P5 adapter, policy negotiation layer, or second active pointer.

## 6. Stop, invalidation, and legacy routes

Before the Engine's durable `switch_committed` transaction, a committed Parent Stop, P5 invalidation, baseline change, scope violation, unsupported Host capability, or other failed eligibility check prevents the switch. Engine A closes mutations and dispatch in the same transaction that records the fixed switch intent.

After that point, Host may complete only the already prepared B switch or restore A if process and Store certainty hold. It cannot select a new source or accept a changed candidate. The Host does not implement P5 Stop/journal semantics. A process/Host crash after the boundary is handled by the fixed Host operation; an uncertain state holds.

A P6-capable desktop Host refuses legacy `lifecycle.activate_candidate` before shutdown/copy, even with valid schema-1 bytes, matching generation, or structural Judge evidence. Every other Engine-accessible release-selection route must use the P6 switch operation or refuse. The old separate Host service remains disabled. Maintainer Host/shell deployment is through its distinct, separately authorized release path and is never callable with Engine lifecycle credentials.

## 7. State compatibility and pre-write startup

P6 v1 requires the installed and candidate Engine to use the same migration catalog and compatible record readers. The actual migration catalog and `schema_migrations` rows are checked before any normal Store constructor can run. No new migration, changed historical migration digest, data-format change, downgrade, or irreversible transformation is allowed.

The preflight entrypoint is separate from normal runner startup because the current runner writes runtime files before Engine initialization. It runs after A is fully stopped and reads Store format/required read contracts from Host-owned disposable scratch through `DatabaseSync(path, { readOnly: true })`; it does not construct the normal migrating Store, write P6 receipts, or begin workload. On Windows, live-profile SQLite read-only access changed `-shm`, allowed a separate writer, and created missing WAL/SHM sidecars. The Host therefore guards the original DB and present sidecars, copies the main DB plus any WAL to scratch, omits transient SHM, rejects a hot rollback journal or ambiguous file set, and hashes/rechecks the original inventory after copying. SQLite may create sidecars only in scratch. The original-store guard remains held while B waits for commit. Results are in `docs/reviews/evidence/2026-10-31-p6-g0-feasibility.json`.

Fallback preserves the current profile data. B preflight happens after A has stopped and Host holds production SQLite guards. If B exits before Host commits B, fallback to exact A is allowed only after all B/Custody/process trees are proved ended and original DB/sidecar bytes, identities, and the Store file-set match the captured production inventory. If any Store/profile state changes or is uncertain, recovery holds; the disposable preflight copy is never restored or promoted, and Host never assumes binary rollback can undo an external effect. Normal Store construction and Engine recovery begin only after Host commit. Any subsequent API or startup failure leaves B selected; automatic A rollback after this write-capable boundary is unsupported.

## 8. P5 enrollment continuation

The installed `profile/p5/enrollment.json` is an immutable root enrollment. P6 does not rewrite it or require a new Owner action after each Engine update.

The Host activation receipt is committed durably with B and remains queryable after Host restart. Before staging, trusted Engine A prepares the successor baseline, running-source artifact, verification-policy artifact, and P5 profile artifact from the exact accepted handoff, using existing P5 schemas. The successor policy preserves the root policy's required checks and all policy bounds while binding B's new installed P5 control/input closure. The successor profile preserves Owner-installed workspace, scope, budgets, repository identity, and Parent/Repair publication refs; only source/release-bound baseline and policy-closure refs advance. `P6BuildReceipt/1` binds this successor P5 profile to the exact B package.

After the normal Store opens without migration, but before the runner's P5 enrollment callback or Engine recovery, B queries/replays the Host's durable activation receipt and writes an idempotent P6 progress response linking the unchanged enrollment root, accepted handoff, BuildReceipt, Host receipt, and prepared successor P5 profile. The P5 reader extension validates the immutable root enrollment file as written, follows the unique P6 progress chain, and constructs an effective enrollment from the root plus the Host-attested successor profile. It verifies every non-release policy/workspace/scope/budget/publication field still matches the root; the current Host-attested package/source release must match the successor profile exactly. If the Host receipt or continuation step is missing, forked, or mismatched, P5 admission remains closed and the same B startup retries that receipt. The root file remains unchanged, no Owner re-enrollment is required, and no generic credential delegation is introduced.

This P6-backed reader continuation is required for autonomous Self-Repair to continue after B. It is not a generic grant. Missing, forked, failed, stale, or Host-mismatched history keeps P5 admission closed. No P6 handoff can widen the policy or revive a stopped Parent.

## 9. Minimal Host compatibility patch

The separately authorized maintainer Host/shell release must add only the demonstrated compatibility behavior:

| ID | Required change | Invariant that fails if omitted |
|---|---|---|
| H-min-1 | Split stable shell identity/root from changing Engine identity/root in `build.json`, Host launch, Tauri bootstrap, and Engine readiness. | Unchanged shell S cannot launch Engine B; current H1 rejects B. |
| H-min-2 | Verify and stage one exact Engine package from the current authenticated Engine before stopping A. | A can be stopped for incomplete, changed, or substituted bytes. |
| H-min-3 | Extend existing installation state with one durable staged operation, recorded A/B identities, preflight phase, switch phase, and one atomic commit. Staging alone never changes selection. | Host restart can lose the staged target, switch twice, or choose an unrecorded directory. |
| H-min-4 | Require A to settle work to zero Custody Jobs; fence new starts and independently verify zero before stopping A. | A provider or old Engine can remain active beside B. |
| H-min-5 | Stop A, guard the production SQLite file set, copy the DB and any WAL to disposable Host scratch, and run B's authenticated read-only preflight only against scratch. Commit B only after exact process/package/Store checks. Permit one A fallback only before Host commit and only with unchanged production Store evidence. | H1 commits before readiness and has no safe fallback. |
| H-min-6 | Refuse legacy Engine-accessible activation in P6-managed desktop mode; advertise a capability absent from H1. | A schema-1 Judge-marker route bypasses exact P5 eligibility and P6 switching. |

Reuse the existing Host process ownership, install lock, authenticated IPC, package digest, atomic file replacement, operations journal, Process Custody, and readiness checks. The P6-capable Host has one durable committed selector in `.deszo-host/active.json`; pending operation and recovery state reside in profile `lifecycle.json`; and `operations.ndjson` records event audit. Pending operation state cannot independently activate a release.

## 10. Required implementation evidence

This contract is not implementation evidence. Future implementation must test:

- Exact P5 handoff and current-eligibility rejection, including Stop/invalidation before the final transaction.
- Two independent trusted Engine bundle builds from separate exact-source materializations; no candidate scripts, plugins, tools, or Host outputs.
- Complete Host file-set/hash validation and frozen-resource provenance.
- H1 refusal before stop and P6-capable legacy-route refusal before any process effect.
- Real Windows Tauri shell S loading Engine B from a different root while preserving the compiled shell identity.
- Custody launch fencing, graceful A shutdown, all Job-empty proofs, no two Engines, and repeated Host restart.
- B preflight before the normal runner path, runtime-file writes, Store constructor/migration, recovery, or API startup, only against a guarded disposable copy made after A's complete stop. Verify DB/WAL copy consistency and that production DB/sidecar bytes and file identities remain unchanged. If B fails, one exact A fallback is allowed only after process certainty and unchanged production Store evidence; changed/uncertain Store holds.
- B's regular API/startup occurs only after Host commit; post-commit startup failure does not silently switch to A.
- Candidate changed-after-verification, partial staging, lost Host reply, concurrent switch requests, failed A stop, B preflight crash, fallback crash, and altered Host state.
- Automatic P5 continuation across at least two Engine-only updates with no repeated Owner enrollment or approval.
- Legacy activation bypass and R14 fault hooks remain closed in packaged release.
- No migrations, state restoration, acknowledged-work loss, or external-effect replay.

See the [recovery matrix](2026-10-30-p6-recovery-matrix.md) for every original C01–C18 boundary. No test in that matrix has been executed by this architecture task.

