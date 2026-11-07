# ADR-0011: Runtime Containment of the Self-Repair Subject Closure

- **Date:** 2026-11-05 (Europe/Moscow)
- **Status:** Proposed. Nothing in section 2 is implemented: no Engine process uses `--disallow-code-generation-from-strings`, no validator is precompiled, and no permission-model restriction is applied. P6 release acceptance stays blocked on the residual in section 5 until section 2 is implemented and independently reviewed.
- **Scope:** Engine process execution policy, a precompiled-validator build step, and the Host spawn arguments. No new updater, approval system, lifecycle service, store authority or sandbox framework beyond the Node and V8 controls named here.
- **Evidence:** [dynamic-key classification](../reviews/evidence/2026-11-05-dynamic-keys/classification.md), [current inventory](../reviews/evidence/2026-11-05-dynamic-keys/inventory-current.json) and the pre-fix [baseline inventory](../reviews/evidence/2026-11-05-dynamic-keys/inventory.json), [reflection-route probe](../reviews/evidence/2026-11-05-dynamic-keys/reflection-routes-probe.txt), [reflection demonstration](../reviews/evidence/2026-11-05-dynamic-keys/reflection-route-demo.txt), [provenance experiments](../reviews/evidence/2026-11-05-provenance/provenance-experiments.txt).

## 1. Context

P5 Self-Repair accepts a candidate after reviewing its source text, verifying its tests, and checking that the subject closure (the Engine modules a candidate may change) is a static import graph the Gate can attest. The Gate's resolver (`importSpecifiers` in `runtime/core/p5Gate.mjs`) is a syntactic check built on the TypeScript parser. It refuses, among other things, loader and realm names written as identifiers, string literals, constant concatenations and templates; `with`; dynamic `import()`; the builtins `cluster`, `vm`, `worker_threads`, `inspector` and `repl` (not `node:test`, which the P5 reproducer tests of a candidate import); the `process` object except its listed members; direct indexing of `Object.values`, `Object.entries` and related reflection calls; and direct imports of the P6 control modules.

A syntactic check is not a capability boundary for JavaScript. The evidence records these gaps, which no syntax rule closes without refusing the Engine itself:

1. **Keys computed at run time.** Element accesses whose key is not a constant remain in the subject closure. Measured on the pre-fix baseline (94 modules, 254 sites): 38 index keys, 212 data-keyed reads, 3 reads of call results, 1 read of a table keyed by a remote protocol. On the current tree (82 modules; 27 of them contain such accesses) there are 230 sites: 195 data-keyed reads and 35 index keys. The contract validator's literal-table lookup is now guarded by `Object.hasOwn`, which removed the one reflective-classified site. No value read through one of them is invoked by name, and none is invoked directly, on the baseline. On the baseline 31 such reads were passed as arguments to calls; on the current tree 28 are. Whether any callee invokes an argument it receives was not established for all of them.
2. **Reflection reaches `Function` through variables.** The direct form `Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => {})))[4].value` is refused. Equivalent routes are accepted when the reflection result is stored in a variable, spread, iterated or indexed in a second statement. Eleven variants were probed on the current tree (`R0`-`R10` in the probe file): R0 is refused, R1-R10 are accepted. R10 is the consequence that matters most: a reflected `Function` builds a module-importing function, `F('u', 'return import(u)')`, which returns the same module instance the import rule protects.
3. **Code generation is in use.** `runtime/core/schemas.mjs` compiles validators with `ajv.compile` at run time (lines 86, 103 and 134). Ajv compiles through `new Function`, so disabling code generation in an Engine process breaks schema validation until the validators are precompiled. The demonstration evaluates a string through the reflected `Function` with default flags; with the code-generation flag it fails with an `EvalError`, exit code 1. The flag is not used by the Engine today.

Consequence: the reviewed source text is not the only code an accepted Engine can execute. A string built at run time, a function reached by reflection, or a module imported dynamically through either runs outside the attested closure and outside the Gate's review. The Gate, the Host attestation and the P6 digest checks protect the bytes of the installed release. They do not protect code that the release generates after start.

Protections implemented on 2026-11-05 (in the source, each tested). They narrow the routes above; they do not close them.

- **Protected P5/P6 control code.** `P6_PROTECTED_CONTROL_PATHS` (`runtime/runner.mjs`, the P6 builder and consumer, their P6 dependencies, `testFaultPolicy.mjs`, `protectedSelfRepair.mjs`, `schemas.mjs`, `canonical.mjs`, `workspaceIsolation.mjs`, `p5GitCandidate.mjs`) is refused as a Self-Repair candidate change in `assertP5HostBoundary` and in the P6 scope classifier. The check compares paths case-insensitively and covers deletions (listed under their old path). Windows 8.3 short names (for example `P6CONS~1.MJS`) are refused as source paths before either check runs. The modules remain part of the installed Engine and the attested control closure. A change to them goes through a separate trusted maintainer release process.
- **Entry-point binding of the builder and the activation.** `runtime/runner.mjs` binds the trusted builder (`bindTrustedP6Builder`, a module-private registry) and the activation (`engine.p6Activation`). `runtime/core/engine.mjs` does not import the P6 consumer, and the resolver refuses a subject import of `p6Consumer.mjs`, `p6Builder.mjs` or `runner.mjs`. **This does not stop reflection:** a reflected `Function` can import the consumer module (R10) and call the same registry-bound function. The import rule removes a direct path only.
- **Test-fault builds.** The Rust Host's common build verifier (`verify_build` in `lifecycle-host/src/lib.rs`) refuses a build whose artifact set lists `.deszo-test-fault-hooks` (case-insensitive) unless `NODE_TEST_CONTEXT` is set. This covers every path that verifies a build. The signal is an ambient environment variable: a Host launched with it admits such builds (section 5).

## 2. Decision

Make the reviewed source and the executed code the same set, with four parts, each testable:

- **C1. No code generation from strings in an Engine process.** Start Engine processes with `--disallow-code-generation-from-strings`. Precompile every schema validator at trusted build time with a standalone generator, and verify each generated module by digest at start.
- **C2. Load only attested modules.** Restrict the Engine's file reads to the installed release root with the Node permission model. The exact flags must be confirmed against Node v22.20.0 by experiment before implementation; this ADR does not assert them.
- **C3. Process creation stays in the modules that already create processes.** `node:child_process` is accepted by the resolver because `adapters.mjs`, `branchDelivery.mjs`, `processes.mjs` and `protectedSelfRepair.mjs` use it; those launches are attested by the Host's Process Custody path where it is enabled. A subject can also start a separate `node` process, which has its own module graph and can import a protected module outside the registry; the design must limit that, and it must not depend on the resolver alone.
- **C4. The trusted control closure is loaded from attested bytes.** Today the Host verifies installed bytes at activation and the Gate checks the running-source inventory of the protected control modules. Not yet implemented for run time: C4 extends the check to every module the Engine process imports, including dynamic imports and imports reached through reflection (R10).

## 3. Invariants

- I1: an Engine process cannot compile or evaluate a string as code. **Not implemented.** Verification when implemented: a process started with the flag, where `new Function('return 1')`, `eval('1')` and an indirect eval each throw.
- I2: every module an Engine process imports, statically or dynamically, is in the installed release and matches its attested digest. **Not implemented.** Verification: an import of a file outside the release root, by any route including a reflected `Function`, must fail.
- I3: a subject module cannot start a process outside the existing launch modules. **Not implemented.** Verification: a runtime probe under C2 and C3.
- I4: a build with test-fault hooks is admitted only in a Node test process. **Implemented** in `verify_build`; the signal is the environment (section 5).
- I5: the trusted builder and the activation are bound by the entry point, and subject modules cannot import the P6 consumer, the builder or the entry point. **Partly implemented:** direct imports are refused by the resolver and tested. Reflection can reach the same module (R10), so I5 holds against direct imports only until I1 and I2 are implemented.
- I6: a Self-Repair candidate cannot change the protected P5/P6 control code. **Implemented** (`P6_PROTECTED_CONTROL_PATHS`, with case-insensitive and short-name refusal and deletion coverage in `p6-builder-boundary.test.mjs`). Repair-time review remains the only control on the protected modules' content.

## 4. Acceptance criteria

1. The reflection demonstration fails inside an Engine process started with C1 and C2, and the failure is recorded as evidence.
2. Full Engine startup, P5 genuine acceptance and automatic P6 activation (`p6-genuine-e2e`, A→B→C and the exhaustion case) pass under the containment.
3. A differential test of precompiled validators against the current Ajv compile path returns identical results for every schema in `docs/schemas`, for valid and invalid inputs.
4. Probes that import a file outside the release root (directly and through a reflected `Function`), and that start a process from a subject module outside the launch modules, all fail under the containment.
5. The Host spawn arguments for Engine processes are asserted in a test, so a regression that drops the flag fails the suite.
6. An independent read-only review finds no open blocker in the containment and its tests.

## 5. Residual, recorded for release review

These are not closed by the implemented protections and are not closed by the static resolver:

- Run-time computed keys (230 sites on the current tree), including keys held in variables or array elements, and string building across statements.
- Reflection through variables (R1-R8 probed and accepted), and the dynamic import through a reflected `Function` (R10). R10 reaches the protected consumer module instance, so the registry-bound builder and activation are reachable by reflection. This is the reason P6 release stays blocked.
- `node:child_process` in subject modules (R9) and a separate `node` process from a subject module, which can import a protected module outside the Engine's registry.
- The reflection-based `CallSite` route is refused by name (`prepareStackTrace`, `getThis`, `getFunction`); a route that reaches a call site without these names was not probed.
- The test-fault signal is the ambient `NODE_TEST_CONTEXT`. A Host launched with that variable admits test-fault builds. A production service must not set it; the installed service configuration is not inspected by this repository.
- Protected control modules are protected from repair, not from review. A change to them still requires the maintainer release process.
- The entry point passes `repairRunId` and `targetEngineBuildId` to the activation unvalidated; the consumer validates the repair link before any write, so this is recorded rather than treated as a bypass.

C1-C4 are the containment that would close these. They are not implemented, and this ADR does not claim otherwise.

## 6. Options considered

- **Keep the static resolver only.** Rejected for release: it cannot close run-time keys, reflection through variables, or the dynamic import through a reflected `Function`, as section 5 records.
- **Refactor the computed keys to literals.** Rejected for this change: most keys index data by design, the rewrite would be large, and it still leaves reflection through variables open.
- **Containment (this ADR).** Proposed. It makes the executed code the reviewed code, which is the property the gate needs.

## 7. Consequences

- Engine startup changes: Host and test spawns add the flags, and the validator build step joins the desktop build chain.
- Until implemented, the residual in section 5 is the release blocker. It is recorded, not waived.
- The schema validators must be regenerated when a schema changes.
- Non-goals: this ADR does not make the Engine immutable, does not add an updater, and does not change P5 verification policy beyond the protected control list.

## 8. Amendment, 2026-11-05: R10 disposition (P6-R10-CLOSE)

**Disposition: Decision C is required. The release remains blocked. Nothing in this section is implemented.** Evidence: [the R10 report](../reviews/2026-11-05-p6-r10-close.md) and [the probes](../reviews/evidence/2026-11-05-r10/).

### 8.1 What was measured or established by code

- **Critical (code-established, not executed): Engine code reaches the Host's P6 switch without reflection.** The Engine holds the lifecycle client (`engine.mjs:136`, from `runner.mjs:144`) and already calls `p6Call` (`engine.mjs:249`). The bridge's `p6Call` admits `engine.stage` and `engine.switch` for any caller in the process (`lifecycleBridge.mjs:104-108`). The Host accepts a self-consistent staged package with the requested digest and checks no P5 proof (`engine_switch.rs:277,424`). This route bypasses the consumer's P5 check.
- R10 reaches the protected consumer by reflection in the same process. The reflected module is the same instance the entry point uses, and it shares the trusted builder registry. Code that holds that instance binds a builder to any object and invokes the protected builder export. The consumer refuses an unaccepted run at the run-link check (`p6Consumer.mjs:349-351`). The P5 acceptance check (`:397-401`) was not reached.
- The consumer takes `engine` from the caller (`p6Consumer.mjs:332`). The run link, handoff and acceptance rows come from that caller's store, and the `resumed` branch (`:392-397`) skips acceptance when a prior admission row exists.
- `--disallow-code-generation-from-strings` closes the reflected `Function` route (EvalError). It does not close `vm.runInThisContext` or `require(esm)` through `process.getBuiltinModule`. Both were measured to run under the flag. The flag also stops the protected graph from loading: `schemas.mjs:79` (`ajv.addSchema`) compiles the meta-schema during import, while the per-schema validators are compiled lazily (`:86`, `:103`).
- The lifecycle bridge's `custody(command)` forwards every `custody.*` command to the Host (`lifecycleBridge.mjs:102`, `lib.rs:1880`). `runner.mjs:147` enables custody for P5-enrolled Engines.
- `node:child_process` is accepted by the resolver (`p5Gate.mjs:301`). A child process receives no bridge (`lifecycleBridge.mjs:61`), but it can write the Store and the staging directory.
- The test-only routes (`runner.mjs:360-374`) are present whenever `testFaultHooksEnabled` is true, which includes source and unpackaged runs without a `build.json`. The Host refuses the marker only outside a Node test process (`lib.rs:1317-1324`).

### 8.2 Why no in-place correction closes it

- The registry can be narrowed to one slot and one Engine object. The consumer would also have to stop taking `engine` from the caller. The lifecycle capability, the direct Engine route, `vm`, `require(esm)` and `child_process` remain.
- Module evaluation order is deterministic. Subject modules are evaluated before `runner.mjs` binds the builder, so a pre-bind of the real Engine object is impossible. The real exposure is top-level subject code that changes Engine classes before construction (`runner.mjs:141`). That exposure is not demonstrated.
- A Host-side P5 check would read acceptance evidence from the Store, and in-process code can write the Store.

So the source-level and registry-level controls cannot be made authoritative inside one trust domain. Decision C is required.

### 8.3 Decision C: minimal architecture, with review requirements

1. **Two principals.** The lifecycle capability for stage and switch, the custody commands that mutate state, and the P5 acceptance writes move to a trusted control process that does not execute candidate code. The repairable Engine process holds none of them.
2. **Role-separated capabilities.** The Engine still needs read-only lifecycle calls: `runningSourceRelease` and `runningSourceInventory` (`engine.mjs:245`, `:328`) and `engine.switch_status` (`engine.mjs:249`). The Host must issue role capabilities, or the Engine's client must lose `p6Call` for stage and switch and the mutating custody commands. A single capability cannot express this.
3. **Authenticated Store records.** The Engine writes the Store, so the control process cannot trust a plain reading of it. P5 acceptance records need an authenticator (for example a MAC) with a key only the control process holds.
4. **Host-spawned control process.** The Host, not the Engine, starts the control process.
5. **Narrow channel.** The Engine requests "activate run R" over a channel with no other request. The control process verifies the request against the authenticated records and runs the consumer.
6. **Host admission.** The Host accepts `engine.stage` and `engine.switch` only from the control process's capability. It still verifies package bytes and the Shell identity. It does not read the Store.
7. **Hardening.** The Engine process runs with `--disallow-code-generation-from-strings` and precompiled validators, including the `addSchema` path at `schemas.mjs:79`. This is hardening, not the boundary.
8. **Lifecycle and crash.** A control-process crash or restart reconciles P6 state from the Store and the Host, as G0 recovery does. A repairable-process crash holds no authority.

Decision C does not close, by itself, Context A (candidate tests reaching the control channel or the Store) or the `child_process` route. Each needs its own containment. This is a process split and a capability model, not a sandbox framework, and it does not expand the Host beyond its present stage and switch checks.

### 8.4 Acceptance tests for Decision C

- The direct Engine route (`p6Call('engine.stage')` and `engine.switch` from repairable code) is refused by the Host, executed against a test-owned Host and installation.
- A reflected or `vm` or `require(esm)` route to the lifecycle capability from the repairable process is refused.
- An unaccepted run cannot cause a stage or switch through any route in the repairable process.
- A `custody.*` command from the repairable process is refused for every mutating command.
- A `child_process` child cannot write the Store or the staging directory.
- The genuine A → B → C path and the exhaustion case pass through the control channel.
- The probes in the R10 report run unchanged and show the refusals in the repairable process.

### 8.5 Status

ADR-0011 stays **Proposed**. Decision C is not implemented, and the R10 gate stays closed until it is implemented and independently reviewed. Section 9 supersedes 8.3 and 8.4 as the design of record.

## 9. Decision C design of record, 2026-11-06 (P6-DECISION-C)

**Verdict: P6-DECISION-C DESIGN BLOCKED.** The missing guarantees are listed in 9.7. This section was revised after an independent review; its dispositions are in the report. Evidence and the full threat model, capability matrix, IPC contracts, migration, regression plan and acceptance criteria are in [the design report](../reviews/2026-11-06-p6-decision-c-design.md). Raw outputs are in [the evidence folder](../reviews/evidence/2026-11-06-decision-c/).

### 9.1 What was demonstrated on this machine (no administrator rights, Windows 11 Home, Node v22.20.0)

- **The direct bridge route activates an Engine without P5.** From Engine code, `p6Call('engine.stage')` and `p6Call('engine.switch')` switched the real Host from Engine A to an unmodified Engine B. The Host journal contains no P5 or Judge event. The Store check is weak (a literal search of `state.sqlite`, which does not cover artifact files); the route never calls the P6 consumer, so no admission record was expected.
- **The `p6Call` allowlist is not a boundary.** `custody()` forwards any command name, so `engine.status` reached the Host through it.
- **One capability authorizes every command family.** The Host issues a single 64-hex capability per run and compares it in constant time for all commands (engine, lifecycle and custody).
- **Same-user processes take that capability.** A child of the Engine read the Host's private heap, found 473 candidate strings, and one authenticated to the Host with a read-only command. The P6 command family accepted it.
- **Same-user children have Store and Owner Token authority.** A child with the verifier's minimal environment opened `state.sqlite`, acquired and rolled back a write transaction, wrote the Store directory, and read the `token` field of `connection.json`. That field is the Owner Token (`runner.mjs:607-608`), which `identifyCaller` accepts on `public` routes. Its lifecycle environment was empty, so environment scrubbing works only for environment variables.
- **AppContainer denies the same-user attacks.** A contained child could not open the parent's process, read its memory, read or write a folder without a grant. A loopback connection to the parent timed out. It could use only the granted folder.
- **Node runs contained only with path-resolution flags for module loading.** With `--preserve-symlinks`, both the main module and a relative `require` ran contained, and their private-folder access was denied. Without the flag, both fail with `EPERM` on `lstat 'C:/'`, because Node's module path walk reaches the drive root. An evaluation that only reads files with `fs` ran without the flag. The ESM loader was not tested.
- **Anonymous inherited handles can carry the channel.** With an explicit handle list, each contained child read its own channel and its reads of the other channels were denied. A `Process.Start` child's reads of the other channels' handle values did not throw, which shows the values were valid there. They returned end-of-stream, not data, so the leak is shown only as valid handles.
- **Named pipes are not yet a usable channel.** A default pipe DACL admitted a same-user child. An explicit per-container SID or package SID denied the granted container too. That result is unresolved.

### 9.2 Principals

- **Host (H).** Owns the installation, staging, selectors, operation journal and process lifecycle. It is the only spawner of the Control Process. It keeps the authority channel, admits stage and switch only on that channel, and verifies the package bytes and the Shell identity as today. It does not run the P5 workflow.
- **Control Process (C).** Runs the P5 acceptance authority and the P6 consumer and builder logic. It runs in its own AppContainer, `DeszoControl`, so that the Store, the acceptance key and the authority channel can be granted to it alone. H spawns it with an explicit handle list.
- **Repairable Engine (E).** Runs in its own AppContainer, `DeszoEngine`. It holds no stage, switch or attach authority, no Store grant and no Owner Token. Its only authority-bearing channel is a write-only request to C: `activate run R`. Its transport to H is anonymous pipes, not loopback, because contained processes cannot reach loopback. Provider custody launches stay with E, scoped by H to its own runs.
- **Verifier (V).** The P5 Gate verification child runs in `DeszoVerifier`. It receives no Store grant, no key and no authority channel. Its result channel is its own inherited stdout.
- **Trust roots, unchanged.** Owner-enrolled root key and P5 enrollment, the Store as authenticated evidence, Git provenance, owner policy, and Host continuation. C verifies them; H verifies C's authority only.

### 9.3 Required properties and how this design meets them

| Property | Mechanism | Status |
|---|---|---|
| Host starts and authenticates C | H spawns C with an inherited authority channel and a per-generation key | Mechanism shown for AppContainer children; C itself not built |
| E cannot obtain stage, switch or attach | Those commands are removed from E's bridge and from any channel E holds; the Host admits stage and switch only on the authority channel, and scopes provider custody to E's own runs | Direct route shown; containment of E shown for CommonJS only; run-owner scoping not built |
| E cannot read the Owner Token | `connection.json` is not granted to E or its children | Shown that a child can read it; denial not shown for this file |
| E's transport survives containment | Anonymous pipe pairs replace loopback | Loopback denial shown; replacement not built |
| P5 evidence is verified by trusted code before it is authenticated | V produces raw results; C recomputes digests from Git provenance and runs the Gate and Judge logic itself; C then writes a MAC over the record | Design only |
| H admits activation only from C | Authority channel is an inherited anonymous pipe; each admission carries a MAC from the C key, a run identifier, a candidate digest and a generation fence | Channel mechanism shown; MAC path not built |
| E requests, never authorizes | E's channel carries one message kind, `activate run R`; C checks run state and acceptance before any stage | Design only |
| Root enrollment, Store, Git, policy and continuation verifiable | C verifies each; H verifies only C's MAC and the package bytes | Design only |
| Mandatory Gate and Judge decisions remain authoritative | C executes them; no Engine-side bypass remains | Design only |
| Genuine A → B → C without Owner approval or Git publication | Authority is not increased; C requires only the existing acceptance evidence | Design only; to be re-run from frozen artifacts |

### 9.4 Acceptance records

C is the only writer. Acceptance rows go to their own file, because SQLite permissions are per file. Each row carries a MAC over its canonical form, keyed by a key that H generates per generation and passes to C over the spawn channel. E and V never hold that key and have no grant to the file. H never reads acceptance rows. H verifies an admission MAC, computed by C over the request fields with a fresh nonce and the generation. Rows written before the change are not trusted; they are re-derived or refused.

Two consequences are not yet resolved. E's own run, event and artifact writes (`engine.mjs`) need a route through C or a stated scope reduction. The P5 Gate and Judge logic run inside the Engine as a mixin (`p5Gate.mjs:751`), so they must be extracted before C can run them.

### 9.5 Restart and recovery

H is the source of truth for the active build and the operation phase. If C crashes, H refuses activation until C restarts and reconciles acceptance rows with its own journal. If H crashes during a fenced switch, it completes or abandons the operation from its journal, as G0 recovery already does. A repairable-process crash holds no authority.

### 9.6 Migration from the Engine-owned consumer

Move `executeP6Activation`, `bindTrustedP6Builder` and the P5 acceptance writes into C. Move the E-side initiators of the switch out of E: `requestEngineSwitch` (`runtime/host/p6Switch.mjs:44-115`), called from `p6Consumer.mjs:645` and from the route at `runner.mjs:363`. Move or re-scope the candidate-side maintenance handshake (`p6Maintenance.mjs:49,54`). Remove `p6Call`, the `custody()` pass-through and attach from E's bridge. Keep `engine.switch_status` and the other read-only lifecycle calls on E's read channel. Test-only routes are present in packages and gated at run time (`testFaultPolicy.mjs:29-34`); containment must re-verify that gate. The owner-facing API and its publication, judge and control-grant routes move behind C or are re-homed.

### 9.7 Missing guarantees that keep the design blocked

1. **The ESM runtime is not shown to run inside an AppContainer.** Only CommonJS was shown, and only with `--preserve-symlinks`. The Engine and C are ESM. The loader path must be shown contained with the same flags, and the import graph must load.
2. **Loopback is unavailable to contained processes.** The Engine's transport to H and the owner-facing API both use loopback. Replacement with anonymous pipe pairs must be built and shown. A loopback capability is untested and is not relied on.
3. **The Owner Token is readable by an Engine child.** Denial of `connection.json` to a contained process is expected by the same mechanism as the private folder, but it is not shown for this file, and the owner's UI must still read it.
4. **Cross-container non-access and handle duplication are not shown.** Denial of read access was shown from a contained child to an uncontained parent. Not shown: a contained child to another contained process, and duplication of the authority handle.
5. **Children of a contained process are not shown to stay contained.** The attempt hung during the spike and was removed.
6. **The handle leak is shown only as valid handle values.** A clean rerun with distinct payloads, and explicit handle lists with non-inheritable server ends for the Host's launches, must be shown.
7. **Custody run-owner scoping is not built.** Without it E can fence C out through attach and reach other runs' custody records.
8. **The P5 Gate and Judge logic cannot run outside the Engine yet.** They are an Engine mixin (`p5Gate.mjs:751`). Extraction is required before C can run them.
9. **Authenticated acceptance is not built.** Until C writes MAC'd rows to its own file and H checks an admission MAC, Store-derived P5 eligibility stays forgeable by any Store-writing process, and E's run, event and artifact writes have no route through C.

Named-pipe admission is not a missing guarantee, because the design does not use named pipes. The unresolved result is recorded in the report, section 5.4.

### 9.8 Status

ADR-0011 stays **Proposed**. Decision C is blocked on 9.7 and is not implemented. The R10 gate and the release freeze stay closed.
