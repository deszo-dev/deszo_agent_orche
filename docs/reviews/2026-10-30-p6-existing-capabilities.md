# P6 Minimal Architecture — Existing Capabilities and Deployment Constraints

Date: 2026-10-30. Investigation baseline: `1f54c47fe265c6b47bf36695be56214056fc3af1`.  
This is a read-only source and document review. No P6 production code, Host build, installation, activation, or user profile was changed.

## 1. Task-start repository state

| Item | Observed before this documentation revision |
|---|---|
| Branch / HEAD | `codex/adr-0003-0005-completion` / `1f54c47fe265c6b47bf36695be56214056fc3af1` |
| Index | No staged changes |
| Existing local changes | `docs/adr/README.md` had one ADR-0010 index row |
| Existing P6 inputs | ADR-0010, P6 architecture review, contracts, capability inventory, implementation plan, and recovery matrix were untracked draft files |
| Other source changes | None observed at task start |

The P5 closure acceptance report is historical evidence at its recorded snapshots. It is not a P6 run or a current full regression. Current P5 source and the later closure amendment take precedence over older statements.

## 2. Current desktop topology

The source has one stable Rust Lifecycle Host outside the version directories. It starts a Tauri shell from a selected release directory; the shell starts a Node Engine from that same release root.

```text
deszo-lifecycle-host.exe
  -> versions/<buildId>/deszo.exe (Tauri native shell + embedded React UI)
       -> versions/<buildId>/runtime/runner.mjs (Node Engine)
            -> provider processes
              -> enrolled P5 uses independent Rust Process Custody Jobs
```

The desktop packager (`scripts/desktop-release.mjs`) expects a matching shell build ID and packages `deszo.exe`, Engine bundle, bridge/shim/runtime resources, P5 support payload, source inventory, and `build.json` under `versions/<buildId>`. The Rust Lifecycle Host is not part of that version directory. The existing Tauri build has no external UI loader.

The P6 H1 compatibility failure is code-backed:

- Rust `verify_build` accepts schema 1 and checks `desktopBuildId` against the selected release ID.
- `src-tauri/src/main.rs::LifecycleBootstrap::validate` checks the bootstrap build ID against the shell's compiled ID and requires the executable directory to equal the selected application root.
- The shell loads `runner.mjs`, bridge, and shim from the same selected application root. It cannot select Engine B from a separate root.
- The current Host stores a global `active.json` pointer plus per-profile `lifecycle.json` state and has a single installation lock for desktop launches.

A copied shell A under B's release directory therefore does not solve the identity coupling: Host requires B while the unchanged executable requires A.

## 3. Capability inventory

| Capability | Current owner and evidence | Reusable capability | P6 gap |
|---|---|---|---|
| Install ownership and native process management | Rust Host: installation lock, managed application Job, stop-and-empty check | Existing lock, process tree, generation, authenticated loopback IPC | Must also fence and prove Process Custody Jobs before an Engine switch |
| Release hashing and source attestation | Rust Host: `candidate_digest`, source inventory, active source release | Exact package digest, source-inventory readers, active release identity | `verify_build` does not implement the P6 manifest schema or exhaustively compare its declared full artifact set |
| Staging | Host validates a path under installation staging; worker copies it to versions after stopping A | Existing staging root, safe path/hash primitives, same-volume rename | No separate finalized stage operation; current copy happens after A stops |
| Activation worker | `lifecycle.activate_candidate`, expected generation, one durable operation, Host worker survives Engine death | Existing worker, operation receipt, launch and generation fencing | Request is tied to a structural Engine Judge marker, not a P5 handoff; legacy route cannot become P6 authority |
| Readiness | `accept_ready` binds managed PID/parent, build, generation, profile, and Store | Existing ready transport and exact process checks | Ready is an Engine report; Store has already been constructed, and no bounded read-only preflight gates commit |
| Crash recovery | `load_or_initialize` and `reconcile_crash` use active and lifecycle files | Existing atomic writes and operation journal | Interrupted early phases fail without replay; a switched B can remain selected; no recorded A fallback |
| Process Custody | Host owns separate native Custody Jobs and spools; Engine shutdown detaches active invocations for later reconciliation | Existing Host-owned Jobs, generation/epoch fencing, terminal records | Lifecycle switch does not itself fence new Custody starts and prove all current jobs ended |
| P5 handoff | Engine/Store creates and exposes the accepted handoff and its object graph | Existing exact P5 identities, receipts, source objects, and current eligibility | No automatic P6 consumer/builder exists |
| P5 source reconstruction | Store artifact verification and P5 source/Git checks exist | Exact source objects, Git candidate, byte/mode identity | Desktop packager requires a clean Git checkout; P6 needs a fixed Store-input adapter |
| Build/package | Fixed low-level bundler and desktop packager; P5 package reproduction checks are present | `bundleRunner`, inventory/copy helpers, pinned runtime dependencies | No P6 operation, accepted-source builder, independent second-root reproduction, or Engine release envelope |
| Store lifecycle | Engine Store supports M1–M22 and WAL; constructor migrates before normal Engine initialize | Existing store ID, migration history, artifacts, command receipts | No pre-constructor P6 check that blocks migrations and no read-only B preflight |
| P5 enrollment | Installation-owned file is create-only and bound to the exact current Host-attested release | Existing enrollment, policy, baseline, and Host identity proofs | Current loader refuses a different current release; no P6 receipt-based continuation after Engine B |
| Rollback | Rust Lifecycle Host has no P6 rollback path. A legacy separate Host service has a different explicit rollback contract and Store. | Do not reuse the service while Rust owns lifecycle | No Rust Host pre-write fallback, previous Engine slot field, or failure receipt |

## 4. B1–B4 and additional process finding

| Finding | Actual source evidence | Required design response |
|---|---|---|
| **B1 — Shell/Engine identity coupled** | Rust `verify_build` compares desktop build ID to selected build ID; Tauri validates its compiled ID and selected root | Separate `shellBuildId/shellRoot` from `engineBuildId/engineRoot` in the separately deployed Host/shell contract |
| **B2 — No independent P6 admission** | Dispatcher accepts `lifecycle.activate_candidate`; request carries a structural Judge evidence marker, not P5 refs | Installed Engine A validates P5; P6-capable Host accepts only an exact fixed Engine release switch and refuses the legacy route |
| **B3 — No durable fallback** | Host changes active selection before readiness; readiness failure marks operation failed; A is not recorded as fallback | One atomic existing Host selector records A, pending B, phase, process identity, and one-shot precommit fallback before effects. Fallback ends at Host commit; normal API startup happens afterward |
| **B4 — Startup may mutate before readiness** | Store construction/migration and Engine initialization precede the runner's ready handshake; runner also writes runtime files before Engine construction | A separate preflight entrypoint must run before normal runner/Store/API startup, then Host commits B before the existing writable startup path |
| **C1 — Custody jobs survive Engine shutdown** | Engine shutdown intentionally detaches Host-owned CLI invocations; Custody Jobs are separate from the managed Tauri Job | Engine A must settle work to zero active Custody Jobs; Host fences new starts and verifies the count is still zero. Host never decides which provider job is safe to kill; uncertainty defers/holds |

H1 must refuse P6. The Host capability must be explicit in the authenticated protocol; H1's version number, Rust binary version, schema-1 manifest, and historical desktop Proof B do not imply support. Proof B replaced a complete desktop release and is not evidence that H1 can run Engine B with shell A.

## 5. Smallest separately deployed Host/shell patch

The proposed maintainer release reuses the Rust Lifecycle Host and Tauri shell code paths. It adds:

1. Shell and Engine IDs/roots in bootstrap, release manifest, and readiness.
2. Exact staged package verification and final rehash before stop.
3. One authenticated Engine switch request and one installation-wide durable Host selection/operation record.
4. Pre-stop stage finalization, using the existing staging and version directories.
5. Engine A settles active work before switch; Host fences new Custody starts and proves no Custody Job is active. Host does not classify or kill workflow/provider jobs.
6. A dedicated B preflight before normal runner side effects, one atomic commit to B, and fallback to exact A only before commit when Store/process state is unchanged.
7. A capability bit absent from H1 and refusal of the legacy activation route in P6-managed desktop mode.

The Host continues to own process and release identity. It does not parse P5 or Judge records, build arbitrary source, manage a second Store, or update itself. The shell/supervisor is a required part of H-min-1; an unchanged H1 shell cannot load a different Engine root.

Use the existing installation-wide `active.json` as the single P6 release selector. The current per-profile lifecycle state and `operations.ndjson` remain receipts/audit, not alternate selectors. If the new authoritative Host state is corrupt or inconsistent, hold rather than select from a directory scan.

## 6. P5, Store, and build constraints

Current P5 provides the exact accepted source graph and current Stop/invalidation state. P6 must recheck it with current installed Engine code; a cached handoff projection or acceptance-time boolean is insufficient.

The Store migration list at this source has M1–M22. The exact installed profile history must be read, not inferred from the latest source number. Existing `Store` constructor migration behavior occurs before Engine readiness, so B's preflight must reject any required migration before that constructor is used.

The current P5 enrollment is a create-only file tied to one Host-attested release. To satisfy P5 continuity without repeated Owner approval, trusted Engine A must prepare successor baseline, running-source, verification-policy, and P5 profile artifacts using existing schemas; after activation, B must link them to the durable Host receipt and unchanged root enrollment before P5 admission. The P5 reader must derive an effective enrollment while verifying all root policy/workspace/scope/budget/publication fields remain unchanged. This is a required narrow P5 reader extension, not an existing capability.

The existing bundle code can produce the Engine runner from a payload. The current top-level release packager requires a clean Git checkout, so P6 must use a fixed trusted adapter that materializes Store objects and invokes existing low-level packager functions. It must not execute candidate scripts, dependencies, or build configuration. The Host hashes exact artifacts but does not independently reproduce the build.

The P5 closure report retains the R6 control-import floor, R14 environment-enabled test fault-hook risk, and the cooperative same-user/F19 boundary. P6 production acceptance must resolve the fault-hook requirement and verify changed trusted control code without claiming hostile-code sandboxing.

## 7. Evidence sources

- [Rust Host lifecycle core](../../lifecycle-host/src/lib.rs)
- [Rust Process Custody](../../lifecycle-host/src/custody.rs)
- [Tauri shell bootstrap](../../src-tauri/src/main.rs)
- [Engine runner startup](../../runtime/runner.mjs)
- [Engine Store and migration constructor](../../runtime/core/store.mjs)
- [P5 handoff and source verification](../../runtime/core/protectedSelfRepair.mjs)
- [P5 Engine admission and startup](../../runtime/core/engine.mjs)
- [Desktop package builder](../../scripts/desktop-release.mjs)
- [Runtime bundle builder](../../scripts/runtime-bundle.mjs)
- [P5 closure amendment](2026-10-30-p5-closure-architecture-amendment.md)
- [P5 closure acceptance](2026-10-30-p5-closure-acceptance.md)
- [ADR-0008](../adr/0008-portable-ephemeral-lifecycle-host.md) and [ADR-0009](../adr/0009-workflow-native-judge-and-exclusive-external-input.md)

No source changes or tests were performed as part of this capability review. These observations describe H1 source and do not attest any installed user's executable.

## 8. 10/31 Windows feasibility amendment

The P6-G0 feasibility probe ran on the current Windows 11 / Node 22.20.0 / SQLite 3.50.4 environment. It found that SQLite `readOnly` is not a physical no-write boundary for a live profile: opening B changed the `-shm` bytes; an independent A writer remained allowed; and read-only opens with absent sidecars created WAL/SHM files. A Host-style native `CreateFileW(GENERIC_READ, FILE_SHARE_READ)` guard blocked writes, deletion, and replacement while held, but could not be acquired while A's SQLite connection remained open. The approved design is therefore post-stop guard plus Host-owned disposable DB/WAL copy, scratch-only B preflight, and no snapshot restoration. Full Windows probe evidence and exact helper identity are in [the feasibility report](evidence/2026-10-31-p6-g0-feasibility.json).

This experiment validates the selected primitive only. It does not prove that the production Host switch operation, restart recovery, or packaged Tauri integration now uses it; those remain G0 implementation acceptance items.

