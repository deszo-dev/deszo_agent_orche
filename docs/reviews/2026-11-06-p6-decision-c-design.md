# P6-DECISION-C: trusted control plane and runtime containment (design, 2026-11-06, revised after independent review)

- **Verdict:** `P6-DECISION-C DESIGN BLOCKED`
- **Precise missing guarantees:** section 9. The main ones: the ESM runtime is not yet shown to run inside an AppContainer; the Engine's transport and the owner-facing API depend on loopback, which an AppContainer cannot reach; the Owner Token route is not contained; authenticated P5 acceptance is not built.
- **Scope:** design and evidence only. No repository source was changed. Nothing was committed, pushed, frozen or regression-tested. The release freeze and the multi-hour regression stay closed.
- **Design of record:** [ADR-0011 section 9](../adr/0011-engine-runtime-containment.md).
- **Evidence:** [docs/reviews/evidence/2026-11-06-decision-c/](evidence/2026-11-06-decision-c/).
- **Predecessor:** [P6-R10-CLOSE report](2026-11-05-p6-r10-close.md).
- **Independent review:** a fresh-context, read-only review returned BLOCK. Each finding was checked against the code or evidence. Section 13 records every disposition.

## 1. Summary

Engine code can activate a candidate Engine on the real Host without any P5 acceptance, through the sanctioned bridge. Any child process of the Engine can read the Host's authority secret from the Host's memory, and it can also read the Owner Token from disk. Process separation under one OS user is therefore not a boundary.

Windows AppContainer does separate processes on this machine without administrator rights. A contained process cannot read the memory of an uncontained parent, cannot read or write folders it has no grant for, and cannot reach a loopback listener. An anonymous pipe whose handle is inherited through an explicit handle list reaches only the container it was given to. Node runs contained once the loader is told not to resolve real paths (`--preserve-symlinks`), and that flag was shown to be necessary for both the main module and a relative `require`.

The design still cannot be accepted. The Engine's transport and the owner-facing API both use loopback, which contained processes cannot reach. The ESM runtime that the Engine and the Control Process use has not been shown to run contained. The Owner Token route and the custody run-owner scoping are not closed. Authenticated acceptance is not built.

## 2. Phase 1: confirmed authority bypass (executed on the real Host)

All runs used a test-owned Shell (`shell-g0`), test-owned Engine packages built with the trusted packager from test clones, and the real Rust Lifecycle Host, under `.deszo/tests/`. Engine A's test clone carried three test-only probe cases, `decision_c_p6_call`, `decision_c_passthrough` and `decision_c_spawn`, added to `runtime/core/testEngineProbe.mjs`. The probe file is gated by the test fault policy and `DESZO_TEST_ENGINE_PROBE`. The repository source is unchanged.

| # | Route | Result | Evidence |
|---|---|---|---|
| 1a | `p6Call('engine.status')` (sanctioned P6 allowlist) | refused: `Unsupported P6 Host command.` | `direct-route-evidence.json` step1 |
| 1b | `custody('engine.status')` (bridge pass-through) | **accepted**; the allowlist is not an enforcement boundary | step1 |
| 2 | Child process from Engine code, verifier-minimal env: opens `state.sqlite`, acquires and rolls back `BEGIN IMMEDIATE`, writes the Store directory, and reads the `connection.json` descriptor, whose `token` field is the **Owner Token** | **all succeeded**; no lifecycle or custody variables present | step2 |
| 2b | Same, with the Engine's full scrubbed environment | same results | step2 |
| 3 | Child process (PowerShell, same user) reads the Host's private heap | **473 candidate 64-hex strings** from 36 regions | step3 |
| 4 | Direct activation from Engine A's bridge: `p6Call('engine.stage')` then `p6Call('engine.switch')` | **Host switched to unmodified Engine B**; `operationPhase: verified`; selector names B and the operation | step4 |
| 4b | Host journal after 4 | journal has no P5, Judge or consumer event | step4 |
| 5 | Process outside any Engine, with one recovered candidate (zero-based index 4) | **authenticated**; `engine.switch_status` reached the P6 status handler, which returned `not_found` | step5 |

Corrections to the first version of this table, from the review:

- The field read in step 2 is the **Owner Token**. `runner.mjs:607-608` says the `firstPartyToken` field is an alias of the Owner Token with no separate privilege tier. The earlier text called it a first-party descriptor and treated it as residual. It is not residual. It is an authority read by a child of the Engine.
- Step 4's Store check searched `state.sqlite` for the literal `p6.switch_admitted`. That is weak: artifact bytes live in `objects/` files, which were not searched. The direct route never calls the P6 consumer, so the absence of an admission record follows from the route. It is not an independent measurement.
- Step 3 shows that a process spawned by the Engine can read the Host's heap. It does not show that the Engine itself can.

Caveats. Step 4 was driven from a probe case added to a test clone. The claim is that code in the Engine process holding the bridge object reaches the Host. This is the threat model. Step 5 used a read-only command. The evidence file contains no capability or token value (checked: zero 64-hex matches).

### 2.1 Highest demonstrated capability level

Engine code can activate a P6 candidate on the real Host without P5 authority, through the sanctioned bridge and without reflection. That is the R10-4 class, now executed. A child of the Engine can read the Owner Token and the Host's authority secret. An unrelated process of the same user can use the recovered authority secret against the Host.

## 3. Phase 1: command inventory and capability matrix

### 3.1 Host command surface (`lifecycle-host/src/lib.rs:1814-1890`, `custody.rs:681-693`)

Every command below is authorized by the same single capability for the whole Host run (`lib.rs:1786`, constant-time comparison). The same capability is handed to the Engine by environment and stdin (`lib.rs:1628`, `:1690`). Dispatch has no principal, so the command set is not restricted by channel. The stage and switch commands are reachable on the same TCP path as status.

| Command | Kind | Reachable from Engine code today | Notes |
|---|---|---|---|
| `engine.ready` | write (own readiness report) | yes (bridge `ready`) | state report scoped to its generation |
| `engine.source_release`, `engine.source_inventory` | read | yes (bridge) | needed by Engine |
| `engine.status` | read | yes, via `custody()` pass-through | not in the bridge allowlist |
| `lifecycle.activate_candidate` | write (legacy whole-release) | yes via pass-through | refused under a P6 Shell (`lib.rs:1834`); **open on non-P6 installations** |
| `lifecycle.receipt_ack` | write (acknowledge own receipt) | yes (bridge) | |
| `engine.stage` | **write (staging)** | yes, via `p6Call` | demonstrated (step 4) |
| `engine.switch` | **write (fence, stop, commit)** | yes, via `p6Call` | demonstrated (step 4) |
| `engine.switch_status` | read | yes (bridge; used by `engine.mjs:249`) | |
| `engine.maintenance_ready`, `engine.maintenance_wait` | write (candidate handshake) | yes; used by the candidate itself (`p6Maintenance.mjs:49,54`) | |
| `custody.attach` | write (new epoch) | yes via pass-through | `custody.rs:827-832`; no owner check |
| `custody.reserve`, `custody.launch` | write (process launch, allowlisted executables) | yes (bridge) | used by normal provider runs; `reserve` returns an existing `custodyId` for any `attemptId` (`custody.rs:876-881`) |
| `custody.ack`, `custody.cancel` | write | yes | owner not checked, only the epoch (`custody.rs:1097`) |
| `custody.stop`, `custody.emergency_stop` | write (process stop) | yes | non-emergency stop checks only the epoch (`custody.rs:1137`); emergency stop uses a per-record credential |
| `custody.status`, `custody.read` | read | yes | epoch check only (`custody.rs:1058`, `:1071`) |
| `custody.source_identity`, `custody.tool_identity` | read | yes | |
| `run_service` custody listener | separate listener and capability | not in bridge `custodyBridgeFromEnvironment` path; `custody.rs:1536-1549`, `lifecycleBridge.mjs:113-124` | **missing from the inventory before this revision** |

Not executed by this stage: the mutating `custody.*` commands. They use the same authority as step 1b, which was executed.

### 3.2 Target capability matrix

| Principal | Authority | Commands and channels |
|---|---|---|
| Host (H), outside containers | owns all state | every command, decided by H; H admits stage and switch only from C's channel |
| Control Process (C), `DeszoControl` | P5 acceptance, P6 consumer and builder | authority channel to H: `engine.stage`, `engine.switch`, `engine.switch_status`, `engine.maintenance_*`; custody reserve, launch and stop for its own verification runs; writes acceptance rows to a separate acceptance file it alone can access |
| Repairable Engine (E), `DeszoEngine` | no stage, switch, attach or fence authority; no Store grant; no Owner Token | request channel to C: `activate run R` only; read-only channel to H: `engine.source_release`, `engine.source_inventory`, `engine.switch_status`, `engine.status`; own-generation `engine.ready` and `lifecycle.receipt_ack`; custody reserve, launch, status, read and ack for allowlisted provider runs of its own runs (see 3.3) |
| Verifier (V), `DeszoVerifier` | none | its inherited result channel only |

### 3.3 Provider launches and run-owner scoping

Normal agent runs launch provider CLIs through custody from the Engine. Removing that would change the product, so the matrix keeps it for E. This keeps only the executable allowlist and digests (`custody.rs:1156-1175`) as protection. It is **not** enough on its own:

- `custody.attach` must move to H only. E cannot fence or re-attach C.
- H must scope `reserve`, `status`, `read`, `ack` and non-emergency `stop` to the run that owns the custody record. Today they check only the epoch. H is the only place that can add that check.
- Whether provider launches should move to a separate Custody principal is a product decision for review. It is not required for the P6 switch authority, which is the blocking issue.

## 4. Threat model

Adversaries: (A1) repairable subject code in E; (A2) candidate tests in V; (A3) any child process of E or V; (A4) an unconfined process of the owner's own user.

| Adversary | Goal | Route demonstrated | Required control | Status |
|---|---|---|---|---|
| A1 | Activate a candidate without P5 | direct bridge route (step 4) | E holds no stage or switch authority; H admits only on C's channel | design; E containment shown for CommonJS only |
| A1 | Recover H's authority secret | heap read by a child (step 3) | E contained; H and C not openable by E | cross-container denial not shown |
| A1, A3 | **Read the Owner Token** from `connection.json` | child reads the descriptor (step 2) | E and its children have no grant to the descriptor; the Owner Token is held by H and the owner's own UI only | **open**; was misclassified as residual |
| A1, A3 | Forge P5 acceptance by writing the Store | Store writable by a child (step 2) | acceptance rows written only by C, into a file only C can access; each row MAC'd | not built |
| A2 | Reach C's key or channel | V is candidate code | V has no Store, key, Owner Token or authority channel | design |
| A3 | Reach H or C through a child | child of E | children of an AppContainer inherit its token | **not shown** |
| A3 | Inherit privileged handles | `Process.Start` leak (section 5.3) and std `Command` inheritance (review finding 7) | every privileged child launched with an explicit handle list; non-target handles non-inheritable | shown for AppContainer; Engine launch not yet changed |
| A4 | Use an authority of the owner's own user | any unconfined process of the user | out of scope: the owner's own processes are the trust domain | residual, recorded |

What the Owner Token authorizes. Its `identifyCaller` path (`runner.mjs:536-541`) accepts it on `public` routes. These include self-repair branch publication (`runner.mjs:334`), judge decision submission (`runner.mjs:422-423`), and control-grant creation, decision and revocation (`runner.mjs:429-430`). The design must move those decisions behind C or make them reachable only from the owner's UI, not from E or its children. Publication and grant decisions are not in the first version's threat model and not in its migration.

## 5. Phase 1: isolation primitives on this machine

Each row is an executed test on this machine as a non-elevated user. Raw outputs are in the evidence folder.

### 5.1 Same user versus AppContainer (`isolation-same-user-vs-appcontainer.json`)

| Action | Same-user child | AppContainer child |
|---|---|---|
| Open the parent process with read access | allowed | **denied** (`Access is denied`) |
| Read a parent memory marker | recovered | **denied** |
| Read a folder without a grant | allowed | **denied** |
| Write a folder without a grant | allowed | **denied** |
| Read and write a granted folder | allowed | allowed |
| Connect to the parent over loopback TCP | connected | **timed out at connect** (not a refusal) |

The AppContainer identity reported itself as contained (`TokenIsAppContainer`). The user-profile listing returned an argument error inside the container, so that row is not a clean ACL result. The private-folder rows are.

### 5.2 Node inside a container (`isolation-node-*.json`)

| Start | Flags | Result |
|---|---|---|
| main module | none | **fails**: `EPERM`, `lstat 'C:/'` in `resolveMainPath`; exit 1 (`isolation-node-main-module-no-flags.json`) |
| main module | `--preserve-symlinks --preserve-symlinks-main` | runs contained; granted write and read allowed; private read and write denied with `EPERM`; private store open denied (`isolation-node-main-module-preserve-symlinks.json`) |
| `node -e "require('./probe.js')"` | none | **fails**: `EPERM`, `lstat 'C:/'` in `_findPath` (`isolation-node-eval-require-no-flags.json`) |
| `node -e` with `require('./probe.js')` | `--preserve-symlinks` | runs contained (`isolation-node-preserve-symlinks-appcontainer.json`) |
| `node -e` that only reads files with `fs` (no module resolution) | none | runs contained (`isolation-node-eval-appcontainer.json`) |

So the flag is needed for module resolution (the main module and `require`), not for every Node start. Evaluation that reads files directly does not resolve modules and runs without it.

Corrections. The earlier text said the main-module failure had no evidence file; it now has one. The earlier text said a relative `require` was exercised without the flag; it was not. The flag is necessary in both cases. The probe `appcontainer-node-probe.js` requires only builtins and reads its sibling file with `fs`, so the `require` case loads one file and does not exercise a dependency chain. The SQLite open of a private path was denied with the generic `ERR_SQLITE_ERROR`; the folder denial is the proof.

Not shown: the ESM loader, which the Engine and C use; the probe does not import any ESM module. Not shown: children of a contained process. The earlier attempt hung and its probe case was removed.

### 5.3 Handle channels (`isolation-handle-channel-results.json`)

- With `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, the engine container read its own channel (`E`). Its read of the control channel's numeric handle threw an invalid-handle error. The control container had the mirror result. This is an isolation result for contained children.
- The `Process.Start` child reached the other channels' numeric handles without an error. The reads returned `-1` (end of stream), not data. Each channel carried one byte that an earlier child had already consumed, so the test is confounded. What is shown: the handle values are **valid** in that child (an invalid handle throws, as it does for contained children). What is **not** shown: that the child received data. The earlier text said the child "could use" the other channels. That was too strong.
- The Host must launch every privileged child with an explicit handle list and must mark non-target handles non-inheritable. A clean rerun with distinct payloads written after the children start is required (in C0).

### 5.4 Named pipes (`isolation-pipe-*.json`)

- A default pipe DACL admitted a same-user child, which connected and exchanged a message. Named pipes therefore need an explicit DACL.
- An explicit DACL admitting one container SID, or `ALL APPLICATION PACKAGES`, denied the granted container as well. The cause is not identified. Named pipes are not the channel in this design. The result is unresolved, not a proof of impossibility.

### 5.5 Windows primitives not available or not tested

- Separate Windows user account: requires administrator rights. Not available to this account.
- Protected process: needs a signed binary. Node cannot use it. Not tested.
- Job objects for tree containment and kill-on-close: exist in the Host (`Win32_System_JobObjects`); not re-tested for containment.
- Mitigation policies: not tested.
- Handle duplication from a contained process to an uncontained parent (`PROCESS_DUP_HANDLE`): not tested.
- Loopback for contained processes through a capability (for example `privateNetworkClientServer`): not tested.

## 6. Process model and trust boundary

```
owner-enrolled root key, Store, Git provenance, owner policy   (verified by C)
                 |
Host H (outside containers; owns installation, staging, selectors, journal, Owner Token)
  |  spawns C with explicit handle list: authority channel pair; key delivered once per generation
  |
  +--> Control Process C  [AppContainer DeszoControl]
  |      - P5 acceptance (Gate and Judge logic, extracted from the Engine, see 8.5), P6 consumer and builder
  |      - writes MAC'd acceptance rows to a file only C can access
  |      - asks H to launch V with an explicit handle list
  |
  +--> Repairable Engine E  [AppContainer DeszoEngine]
  |      - request channel to C: "activate run R"       (write-only, one message kind)
  |      - read-only channel to H                       (anonymous pipe pair, not loopback)
  |
  +--> Verifier V  [AppContainer DeszoVerifier]
         - inherited result channel only; no Store, key, Owner Token or authority channel
```

Authority flows only from H to C and from C to H. E and V have no channel that carries authority. The owner's UI keeps the Owner Token and reaches the owner-facing API through a channel that is not inherited by any contained process.

## 7. Channels and admission

- **Transport.** Anonymous pipes, not loopback TCP. Loopback is denied to contained processes (section 5.1). The current bridge (`lifecycleBridge.mjs:45`) and the Host listener (`lib.rs:668`) both use loopback, so E's transport changes. Loopback through a capability is untested and is not relied on.
- **Two pipes per channel.** An anonymous pipe is one-way. A request channel and a response channel are separate pipes.
- **Server ends non-inheritable.** The Host keeps the server ends private. A client end is inheritable only during spawn and is cleared afterwards.
- **Explicit handle lists.** The Engine's launch (`lib.rs:1573-1650`) currently uses a standard `Command` with no explicit handle list. The reviewer reports that Rust's standard library on Windows enables handle inheritance for it (not reproduced here). Any inheritable handle the Host holds at that moment would reach E. The custody spawn already uses an explicit list (`custody.rs:1709`). The Engine launch must do the same. This is a required C1 change.
- **Admission message.** `stage` and `switch` carry the operation identifier, run identifier, candidate digest, acceptance identifier, generation, a fresh nonce, and a MAC over those fields with the C key. The generation is public (`lib.rs:1631`, returned by `engine.status`), so it is a fence, not authentication. The MAC and the nonce authenticate.
- **H checks.** Channel identity, MAC, generation, single-use nonce, package bytes, Shell identity. H does not read rows from the Store and does not run P5.
- **Replay.** Nonces are recorded in H's journal per generation. A repeated switch returns the recorded outcome and starts nothing, as G0 does today.

## 8. Implementation contracts

### 8.1 E to C: request

- `{ "kind": "activate", "runId": "<uuid>", "requestId": "<uuid>" }` on E's request pipe. C answers on its response pipe with `{ "requestId", "outcome": "accepted" | "refused", "reason" }`.
- E can send no other kind. C refuses and logs any other kind.

### 8.2 C to H: authority

- `engine.stage` and `engine.switch` as in section 7.
- `engine.switch_status` for recovery.
- Custody reserve, launch and stop for C's own verifications, each carrying the C MAC.

### 8.3 E to H: read-only, plus own-generation reports

- Read: `engine.source_release`, `engine.source_inventory`, `engine.switch_status`, `engine.status`.
- Own-generation reports: `engine.ready` (its own readiness) and `lifecycle.receipt_ack` (its own receipt). These are writes, but they carry no authority over the switch or the custody fence. The review pointed out that they are writes; the wording "no mutating command" is therefore wrong, and this section now states exactly what is on E's channel.
- Provider custody per 3.3, scoped by H to E's own runs.
- Not on E's channel: stage, switch, maintenance commands from the Host side, attach, emergency stop of other runs, fence.

### 8.4 V to C: results

- Raw check results on V's inherited stdout. C treats them as untrusted until it recomputes digests from Git provenance and runs the Gate and Judge logic itself.

### 8.5 Acceptance record lifecycle

1. C starts a P5 run. H launches V under `DeszoVerifier` with its result pipe.
2. V returns raw results. C recomputes the candidate digest from Git provenance, recomputes each check's input digest, and applies the Gate and Judge decisions.
3. C writes one acceptance row, MAC'd over its canonical form and the generation, to its acceptance file.
4. An `activate` request names the run. C verifies the row's MAC and the run's state, then issues `engine.stage` and `engine.switch` on the authority channel with the admission MAC from 7.
5. H verifies the admission MAC, not the row. H never reads acceptance rows.
6. Rows written before the change are not trusted. They are refused, and the run re-enters P5.

**Extraction required.** The Gate is installed as a mixin on the Engine class (`p5Gate.mjs:751`, `installProtectedSelfRepairGate(Engine)`). It reads `this.store`, `this.custodyHost` and `this.lifecycleClient`, and it builds the verification receipt inside the Engine (`p5Gate.mjs:1359-1382`). C therefore cannot run it as it stands. Listing the Engine state each function reads, and moving those functions into C, is a required C0 or C3 deliverable. The Judge logic (`workflowJudge.mjs`) was not inspected and must be included in that extraction.

### 8.6 Restart, recovery and supervision

- H restarts C if it exits, with a new generation and a new key. C reconciles its rows with H's journal before it accepts any request. Until then activation is refused.
- If H crashes during a fenced switch, H completes or abandons the operation from its own journal, as G0 recovery does. This needs no authority from C.
- If E crashes it holds no authority. H restarts it under the current generation.
- A broken pipe is a refusal, never a retry with a different principal.

### 8.7 Failure modes

| Failure | Behaviour |
|---|---|
| C not running | activation refused |
| V crashes or times out | no acceptance row; the run stays in P5 |
| Acceptance row MAC invalid | refused; the run re-enters P5 |
| E sends an unlisted request kind | refused and logged |
| H restarted mid-switch | reconciled from the journal |
| Acceptance file unreadable | refused, nothing written |

### 8.8 Migration from the Engine-owned consumer

1. Move `executeP6Activation`, `bindTrustedP6Builder` and the P5 acceptance writes into C.
2. Move the **E-side initiators** of the switch out of E: `requestEngineSwitch` in `runtime/host/p6Switch.mjs:44-115`, called from `p6Consumer.mjs:645` and from the route at `runner.mjs:363`.
3. Move or re-scope the **candidate-side maintenance handshake**: `p6Maintenance.mjs:49,54` calls `engine.maintenance_ready` and `engine.maintenance_wait` through `p6Call`. The candidate runs it itself, so it must move to a channel the candidate can use for its own handshake only, with H deciding.
4. Remove `p6Call`, the `custody()` pass-through, and attach from E's bridge.
5. Give E the read-only channel and the request channel from 8.1 and 8.3, on pipes, not loopback.
6. The owner-facing API (`runner.mjs` HTTP server, loopback) and its Owner Token route set must be re-homed or re-verified under containment. The publication, judge and control-grant routes listed in section 4 move behind C.
7. Test-only routes (`runner.mjs:360-375`) are gated at run time by `testFaultPolicy.mjs:29-34`. They are present in packages, not absent. Containment changes what `existsSync` reports there, so the gate must be re-verified under containment.
8. Existing G0 and P5 tests that drive the Engine route are re-pointed through C.

## 9. Missing guarantees (why the verdict is BLOCKED)

1. **ESM in a container.** Only CommonJS was shown. The probe imported no ESM module. C and E are ESM. The loader must be shown to run contained with the same flags, and the runtime's import graph must load.
2. **Loopback.** The Engine's transport and the owner-facing API use loopback. A contained process cannot reach loopback (section 5.1). The replacement (pipes, section 7) must be built and shown, or a loopback capability must be shown to work.
3. **Owner Token containment.** The token is readable by a child of the Engine (step 2). Denying a contained process a read of `connection.json` is expected to work, by the same mechanism as the private folder, but it is not shown for this file, and the owner's UI must still read it.
4. **Cross-container and duplication.** Denial of read access was shown from a contained child to an uncontained parent. Not shown: a contained child to another contained process, and duplication of the authority handle.
5. **Children of a contained process.** Expected to stay contained, because children inherit the token. Not shown.
6. **Handle leak, cleanly.** The leak is shown only as valid handle values in the uncontained child (section 5.3). The Host's explicit handle lists and the non-inheritable server ends must be shown, with distinct payloads.
7. **Custody run-owner scoping.** Not built. Without it E can fence C out through attach and reach other runs' custody records (section 3.3).
8. **Gate extraction.** The P5 Gate and Judge logic run inside the Engine. C cannot run them until they are extracted (section 8.5).
9. **Authenticated acceptance.** Until C writes MAC'd rows and H checks an admission MAC, Store-derived P5 eligibility stays forgeable by any Store writer. This is shown by step 2 (the Store is writable by a child) and by `p6Consumer.mjs:171-187` and the `resumed` branch at `:396-397`.

Named-pipe admission is not a missing guarantee, because the design does not use named pipes. The unresolved result is recorded in section 5.4.

## 10. Implementation plan (after the blocking items are closed)

- **C0. Spikes (no product code).** ESM under containment with the flags; cross-container denial; child-of-container containment; handle duplication denial; loopback capability (for completeness); a clean handle-leak rerun with distinct payloads; `connection.json` denial for a contained process.
- **C1. Launch and handles.** Host launches E, C and V with explicit handle lists. Replace the standard `Command` for the Engine launch. Non-target handles marked non-inheritable. Job object retained for tree kill.
- **C2. Transport.** Anonymous pipe pairs for E-to-H and C-to-H, replacing loopback for these channels. MAC keys per generation. Admission checks and nonce journal.
- **C3. Acceptance authority.** Extract the Gate and Judge logic (8.5) into C. Acceptance file, MAC'd rows.
- **C4. Engine request channel.** E sends `activate` only. Remove E's stage, switch, attach and pass-through. Move the E-side initiators and the maintenance handshake (8.8).
- **C5. Custody run-owner scoping** in H, and attach removed from E.
- **C6. Recovery.** Reconcile C with H's journal on restart; fail-closed tests.
- **C7. Migration and tests.** Re-point G0 and P5 tests through C; re-verify the test-route gate under containment; re-home the owner-facing API.

No step starts until C0 is complete, because C1 depends on the containment result.

## 11. Regression plan

Expected results are per step and per channel. The first version said step 5 would be refused. It would not: step 5 is `engine.status`, which E keeps as a read.

- **Probe, re-run after C4.** Expected results:
  - 1a: refused (allowlist).
  - 1b: refused. `custody()` pass-through no longer forwards non-custody commands from E.
  - 2: the child cannot read the Store, the Owner Token descriptor, or the acceptance file.
  - 3: the child cannot read H's heap (contained).
  - 4: E cannot stage or switch. Refused on the authority channel check.
  - 5: the outside process cannot use a recovered secret, because no authority secret exists outside H and C.
- **Containment:** the C0 spikes re-run after C1.
- **Protocol:** unit tests for admission (MAC, nonce, generation, channel identity), refusal of unlisted request kinds, and the failure modes in 8.7.
- **Integration:** the G0 switch and recovery tests, re-pointed through C, and the P5 end-to-end suite.
- **Acceptance:** the genuine A → B → C run and the exhaustion case, from frozen artifacts, without Owner approval or Git publication.
- **Full regression and source freeze:** only after everything above passes. Not run now.

## 12. Acceptance criteria for `DESIGN ACCEPTED`

All of the following must be shown, with evidence files:

1. The ESM runtime (C and E) runs inside an AppContainer with the flags it needs, and loads its import graph.
2. A contained process cannot open, read memory of, or duplicate a handle from another contained process, from H or from C.
3. A child process of a contained process is contained.
4. Only C holds the authority channel. E and V, given every numeric handle value, cannot use any other channel. Demonstrated with distinct payloads.
5. **No candidate-controlled process** (E, V or their children) can read the Store file, the acceptance file, the admission key or the Owner Token. Same-user unconfined processes are outside this boundary, as the owner's own trust domain (section 4, A4). The earlier wording "a same-user process cannot read" was wrong, because the account's own processes can read anything the account can read; this criterion is restated for the real boundary.
6. H refuses `stage` and `switch` from any channel except C's, with a valid MAC, nonce and generation. Demonstrated on the TCP path as well, which is removed for these commands.
7. P5 acceptance rows are written only by C. H verifies the admission MAC, not the rows. A row without a valid MAC is refused.
8. E cannot cause a stage or switch through any route, including the probe in section 2.
9. The Owner Token is not readable by E or its children, and the publication, judge and control-grant decisions are not reachable from E.
10. Custody commands are scoped to the owner run in H, and attach is not reachable from E.
11. A C crash fails closed, and recovery reconciles with H's journal.
12. The genuine A → B → C path passes through C without Owner approval or Git publication.

## 13. Independent review and dispositions

A fresh-context reviewer, reading only the repository and the evidence, returned **BLOCK**. Each finding was checked against the code or evidence before the document changed. Dispositions:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Critical | The step-2 field is the Owner Token; A3 route, not residual | **Confirmed** (`runner.mjs:607-608`, `:536-541`); section 2, 4, 9.3 corrected |
| 2 | Critical | Criterion 5 and the key model conflict with H's heap | **Confirmed** as a conflict; criterion 5 restated for the candidate-controlled boundary (section 12.5) |
| 3 | Critical | Engine transport fails under containment | **Confirmed** (`lifecycleBridge.mjs:45`, `lib.rs:668`, section 5.1); section 7, 8.5 changed; replacement must be shown |
| 4 | Critical | Store grant to C only conflicts with the Engine's writes | **Accepted as an open scope question**: E's run, event and artifact writes need a route through C or a stated scope reduction. Added as a required C3 deliverable and as missing guarantee 9 |
| 5 | Major | Host authorization per capability, not per principal | **Confirmed** (`lib.rs:1628`, `:1690`, `:1786`, dispatch at `:1814-1890`); section 3.1 and 7 changed |
| 6 | Major | Custody has no owner check; section 3.3 contradicts 3.2 | **Confirmed** (`custody.rs:827-832`, `:876-881`, `:1058`, `:1071`, `:1097`, `:1137`); 3.2 and 3.3 corrected |
| 7 | Major | Authority channel under-specified; std inheritance | **Partly confirmed**: one-way pipes and the explicit-list requirement are design facts; the std inheritance claim is the reviewer's reading of the Rust source, not reproduced here, and is listed as a C1 requirement |
| 8 | Major | Handle-leak result misreported | **Confirmed** (`anon-plain.json`; reads returned `-1`); section 2 and 5.3 corrected |
| 9 | Major | Node evidence missing or overstated | **Confirmed** for the main-module and flagless cases; **now evidenced** (`isolation-node-main-module-no-flags.json`, `isolation-node-eval-require-no-flags.json`); flags recorded in outputs (`nodeFlags`, `nodeMode`) |
| 10 | Major | Internal contradictions (a)–(e) | **Confirmed and corrected**: switch_status kept on E's read channel; "no mutating command" restated; custody 3.2 and 9.3 aligned; H verifies admission MACs, not rows; section 4 residual rewritten |
| 11 | Major | Migration misses E-side P6 callers | **Confirmed** (`p6Switch.mjs:44-115`, `p6Consumer.mjs:645`, `runner.mjs:363`, `p6Maintenance.mjs:49,54`); 8.8 changed |
| 12 | Major | C cannot run the Gate in its current form | **Confirmed** (`p5Gate.mjs:751`, `:1359-1382`); 8.5 and C3 changed; Judge not inspected, stated |
| 13 | Minor | Wording and proxies | **Accepted and corrected** (a)–(i): test-route gate is present in packages and gated at run time; step-4 Store check is weak; three probe cases; "reached the P6 handler, which returned not_found"; staging wording removed; loopback result is a timeout; SQLite permissions are per file, so acceptance rows need their own file; generation is a fence; candidate index is zero-based |
| 14 | Minor | Scope gaps: legacy activation on non-P6 installs; custody `run_service` listener | **Confirmed and added** (section 3.1) |

Claims the reviewer verified and that stay as written: the step-4 path checks only the Shell identity, generation, active build and a self-consistent digest (`engine_switch.rs:279-296`, `:324`, `:436-454`); the allowlist is bypassed because `custody()` forwards any command (`lifecycleBridge.mjs:102`, `lib.rs:1880-1887`); one capability per run, compared in constant time, never written to disk (`lib.rs:671`, `:711-714`); lifecycle variables are removed before children start (`lifecycleBridge.mjs:61`); the verifier environment is minimal (`p5Gate.mjs:1072-1074`); the probe is gated (`testEngineProbe.mjs:36`); P6 Shell refuses legacy activation (`lib.rs:1834-1836`); test-fault builds are refused outside Node tests (`lib.rs:1323-1325`); custody allowlist is by path and digest (`custody.rs:1156-1175`); emergency-stop credentials are per record (`custody.rs:1129-1134`); store-derived P5 eligibility is forgeable (`p6Consumer.mjs:171-187`, `:396-397`).

The reviewer's unverified items are listed in section 14.

## 14. Evidence index and what was not verified

Evidence (in [docs/reviews/evidence/2026-11-06-decision-c/](evidence/2026-11-06-decision-c/)):

- `direct-route-probe.mjs`, `direct-route-evidence.json`, `direct-route-run.log`: section 2.
- `memscan.ps1`: the heap reader used in step 3.
- `appcontainer-spike.cs`: the single spike program (modes `run`, `run-node`, `pipe-run`, `handle-run`).
- `isolation-same-user-vs-appcontainer.json`: section 5.1.
- `isolation-node-*.json` (five files): section 5.2.
- `isolation-pipe-*.json` (three files): section 5.4.
- `isolation-handle-channel-results.json`: section 5.3.
- `appcontainer-node-probe.js`: the contained probe.

Not verified (carried forward):

- libuv child-process handle inheritance: needs a Node test.
- Whether an unconfined same-user process can open an AppContainer process with `PROCESS_DUP_HANDLE`: not tested.
- Whether a loopback capability works for contained processes: not tested.
- Whether ESM loads inside a container with the flags: not tested.
- `workflowJudge.mjs` coupling, the ADR-0006 control client's handling of `runtime.ready`, and the bodies of custody read, status and ack beyond their epoch checks: not inspected in full.
- The Rust standard library's handle inheritance for the Engine launch: reported by the reviewer, not reproduced.
- The reviewer ran read-only tools only. This stage's own spikes were run once each on this machine; reruns were not done.
