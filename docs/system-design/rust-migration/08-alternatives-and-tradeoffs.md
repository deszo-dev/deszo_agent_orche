# 08. Alternatives and tradeoffs

## 1. Options

| Option | Shape | Where acceptance authority lives |
|---|---|---|
| **A** (selected) | Rust Host + Rust Engine; Admission is a module of the Host; Engine and all candidate or provider executions contained | Host |
| **B** | Rust Host + Rust Trusted Control process + Rust Engine | Control process; the Host admits stage and switch only from Control |
| **C** | One codebase and fewer binaries, with execution roles chosen at start | Depends on the variant (§3) |
| A-S (variant considered) | Host runs as a separate OS account (service), Engine not contained | Host |

The earlier P6-DECISION-C design is a JavaScript form of Option B (ADR-0011 §9). It was blocked mainly on Node-specific and transport issues (ESM under AppContainer, loopback, Owner Token placement) and on extracting the Gate and Judge from the Engine mixin (`runtime/core/p5Gate.mjs:751`).

## 2. Comparison

| Criterion | A: two backend processes | B: Host + Control + Engine | A-S: Host as separate account |
|---|---|---|---|
| Security: can repairable code obtain trusted authority | No privileged verb on the Engine channel; containment denies Host state | Same, plus a second trusted channel (Control to Host) that must be authenticated and fenced | The Engine is same-user with the Shell and the provider CLIs, so the Owner Token in the Shell and every provider run stay reachable; containment is still needed |
| Complexity: processes, IPC, protocols, state machines | 2 backend processes, 1 Engine protocol, 1 admission state machine inside the Host | 3 backend processes, 2 protocols, admission state split across two processes plus reconciliation on Control restart (Decision C §8.6) | 2 processes, but a service plus an interactive launcher to start user-session processes (the ADR-0006 direction) |
| Self-Repair A → B → C | Supported (04 §8) | Supported | Supported |
| Rust build | Same in all options: contained build jobs | Same | Same |
| Host size (trusted code) | About 15,000-17,000 lines including Admission, scopes and the gateway witnesses (sizing hypothesis) | Host about 10,000 lines, Control about 6,000 plus its IPC and recovery; the trusted total is larger | Similar to A plus service plumbing |
| Store separation | Host protected store, ACL-enforced (05 §3) | Control-owned store; same mechanism | Service-account ACLs |
| Recovery | One journal owner; Host restart reconciles everything | Two trusted processes must reconcile with each other; a Control crash must fail closed while the Host keeps running | Service restart semantics; user-session processes outlive the service in some failure modes |
| Portability | Containment adapter per platform (03 §6) | Same adapter, plus a second trusted process to package | Needs administrator installation on every platform |
| Testing | Admission tested in-process with fixture jobs | Extra protocol and crash-matrix tests between Control and Host | Service-mode tests need elevated CI |
| Migration from today | Moves the JS Gate, consumer and builder logic into the existing Rust Host | Builds a new process and a new protocol in addition | Installer change with administrator rights |
| Maintenance | One trusted binary to release | Two trusted binaries with a compatibility matrix | One trusted binary, service tooling |

**Why B is rejected for now.** A separate Control process is justified only by a security or reliability need that Option A cannot meet. On authority, Control would still take part in trusted acceptance, so it does not remove anything from the trusted computing base; Decision C's reason for its separate principal (an acceptance store granted to Control and not to a same-user Engine) is met by containment and the Host-only directory. On reliability, a Control process under its own constrained principal could isolate parser crashes, resource exhaustion and aborts from the lifecycle functions, which an in-process worker cannot fully do (02 §10). That value is real but unmeasured, and it costs a second protocol, its authentication, a crash and reconciliation matrix and a second trusted release unit.

**When B would be reconsidered.** When the Host-reliability tests (07 §5) show a failure caused by untrusted input that the bounds of 02 §10 do not contain, or Admission needs a large parsing dependency in the trusted process (for example a full Git library). Line count alone is not a reason.

**Why A-S is rejected.** Running the Host as a different OS account protects Host state and memory, but not the Owner Token held by the Shell, not provider runs, and not the user's files from a same-user Engine. Containment of the candidate-controlled processes is required in any case, and once it exists, a separate Host account adds administrator installation and a session launcher without closing another gap.

## 3. Option C: binaries, processes and principals

One binary does not mean one process, and one process does not mean one trust domain. The counts for the selected design:

| Count | Value |
|---|---|
| Source repositories | 1 |
| Crates | 12 (02 §5); `deszo-providers` and `deszo-git` may start as Engine modules |
| Shipped binaries | 5: `deszo-host`, `deszo` (Shell), `deszo-engine`, `deszo-mcp`, `deszo-harness` |
| Long-running processes | 3: Host, Shell (while the UI is open), Engine |
| Backend processes | 2: Host, Engine |
| Security principals | the user (Host, Shell, external clients); one principal per Engine build; one per Run; one per verification, harness, build, seed or export job; one per protected Judge invocation |

Variants of Option C:

| Variant | Assessment |
|---|---|
| One binary containing Host and Engine roles | Rejected. P6 replaces the Engine binary; a shared binary would mean P6 replaces Host code, which breaks Host immutability (ADR-0010 §3) |
| Host and Shell in one process | Not adopted. It removes one binary, but WebView and window lifetime (exit on last window close) would govern the Host, and UI faults would reach the lifecycle functions. Can be revisited without changing any boundary |
| One Engine binary with modes (normal, maintenance preflight) | **Adopted.** Today's `--p6-maintenance` entry (`runtime/runner.mjs:659-667`) becomes a typed `Bootstrap` field |
| A separate Deszo "job runner" binary for verification and build jobs | Not needed. Jobs run the pinned Cargo and test binaries directly under Host containment |

## 4. Node.js with ADR-0011 versus a Rust backend

| Aspect | Path 1: complete Node + ADR-0011 | Path 2: Rust backend with the minimum boundary |
|---|---|---|
| Time to a trustworthy release | Shorter if a contained Node Engine is proven (PR-1 with ESM and `--preserve-symlinks`, unproven today); the Engine and its tests are reused | Longer by the Engine rewrite (M5-M6) and the test migration |
| Runtime components | Host, Shell, Node Engine, bundled Node runtime | Host, Shell, Engine executable |
| Security properties | With Host Admission and containment: the same as Path 2. Without them: blocked (ADR-0011 §9) | As designed in 03 |
| Complexity of Self-Repair | esbuild builds do not execute candidate code; candidate tests do | Cargo builds execute macros and build scripts, so builds need containment; admissions take longer (multiple Cargo builds) |
| Testing burden | Existing 37,000 lines of tests reused, re-pointed | Contract map and Rust tests to write; differential harness |
| Long-term support | Two backend languages; Node runtime updates; JS dependency closure | One backend language; toolchain and vendor updates by maintainer release |
| Cross-platform | Node portable; containment adapter needed anyway | Same adapter; native binaries per target |
| Reuse of the Rust Host | Yes | Yes, and the protocol types are shared Rust code instead of duplicated JSON shapes |
| Risk of rewriting mature functionality | Low | High: 25,000 lines of Engine logic with many recovery and P1/P2/P3 subtleties |

What Rust actually eliminates: the bundled Node runtime and its packaging; the uncertainty of the Node module loader under containment; the ESM import-closure resolver, reflection audits, code-generation flags and Ajv precompilation (01 §3); the entry-point builder injection; the test-fault module policy (a compile-time feature instead); two-language protocol drift between Host and Engine.

What survives regardless of language: containment of the Engine and of candidate and provider executions; replacement of loopback for contained processes; the Owner Token's move out of the Engine; acceptance decided by trusted code from its own evidence; the semantic limit of Judge and tests; Store and canonical-JSON compatibility; the G0 switch and recovery; the workspace slot pool.

An important consequence: once Admission is in the Host and the Engine is contained, ADR-0011's in-process controls C1-C4 are no longer needed in **either** path, because the Engine no longer holds authority that reviewed-code equality would protect. The two paths then differ mainly in Engine rewrite cost against Node runtime and loader cost. The Owner's decision selects Path 2. The plan builds the boundary first (M1, M4, M7), so that work is useful whichever way the Engine schedule develops. Whether to ship an interim release with a contained Node Engine is a scheduling question, recorded as OD-7; the final design has no Node backend either way.

## 5. Engineering cost

Relative estimates in engineer-weeks for one engineer familiar with the codebase, revised after the reviews to include the protected Parent witness, the harness and resource scopes; to be reassessed after M1. Assumptions: the contract freeze (M0) is complete before Rust work starts; fixture providers stand in for real CLIs; Windows only; the prerequisites pass on the first or second attempt. Ranges, not dates.

| Work item | Estimate | Main uncertainty |
|---|---|---|
| Rust Engine core (scheduler, Runs, attempts, recovery, API handlers) | 10-18 | Recovery and continuation edge cases |
| Store and canonical JSON | 3-5 | Number formatting and key-order compatibility |
| Workflow orchestration (Loop, Map, Task, review Gate, context packages, delivery) | 6-10 | Breadth of recorded behavior |
| Provider CLI integration | 3-5 | Native stream format drift |
| P5 Admission: Parent witness, authorization, checkpoints, protected questions and Stop | 7-12 | Gateway witness rules; Owner question flow |
| Causal harness (`deszo-harness`) and scenario format | 4-7 | Expressing incidents as black-box scenarios (PR-9) |
| Workflow resource scopes (bindings, policy, Run principals) | 4-8 | PR-8 and PR-2 results |
| P6 build jobs, reproducibility, receipts | 3-6 | MSVC determinism (PR-4) |
| Cargo toolchain and vendor management | 2-4 | Toolchain identity with MSVC linker and SDK |
| Host isolation (sandbox module, profiles, grants, handle lists) | 4-8 | PR-1 and PR-2 results |
| API gateway and Owner Token move | 2-4 | SSE forwarding |
| Test migration and differential harness | 8-14 | Number of contracts without a clean recording |
| Release packaging, cutover, `deszo-mcp` | 3-6 | Installer and rollback rehearsal |
| **Total** | **about 65-115** | |

Other costs:

- **Runtime overhead:** one extra hop for each API request (gateway to Engine over a pipe), well under a millisecond locally; a container launch per provider attempt and per job.
- **Compile time:** each admission runs at least four Cargo builds (verification, baseline with reproducer, two production builds). With a dependency cache (04 §5) an admission should take minutes to tens of minutes; this replaces the seconds of an esbuild bundle.
- **Build infrastructure:** a pinned toolchain and a vendored dependency set per installation, hundreds of megabytes.
- **Security complexity:** concentrated in two Host modules, `sandbox` and `admission`.
- **Maintenance:** one backend language; protocol-version management between Host and Engine; toolchain updates only through maintainer releases.

**Critical path:** M0 → M1 (PR-1, PR-2) → M4 → M5 → M6 → M8 → M9. Engine parity (M5-M6) is the longest segment; Admission (M7) runs beside it.
