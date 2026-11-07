# 15. Variant 3 feasibility report

- **Task:** DESZO-RUST-MIGRATION-FEASIBILITY-V3
- **Run date:** 2026-11-06
- **Scope:** Isolated Rust prototype only. No production Host, Node Engine, Store, enrollment, Self-Repair policy, or ADR status was changed.
- **Architecture follow-up:** [Repairability by Design delta proposal](variant3-repairability-delta-proposal.md).
- **Result:** The workspace compiled, but the launcher could not create an AppContainer profile and stopped before the Protected Core started. Required OS-boundary behavior is therefore untested.
- **Decision state:** ADR-0012 remains **Proposed**; Variant 1 remains the documented baseline; OD-12 remains unselected.

## 1. Executive summary

The isolated workspace at [`experiments/rust-migration-v3`](../../../experiments/rust-migration-v3/README.md) builds a Host, Protected Core, two useful Worker variants, a fault Worker, and a shared typed protocol. The release build completed offline. The actual run then failed at `CreateAppContainerProfile` with `HRESULT 0x80070057`, before Core or Worker launch.

The launcher token itself reports AppContainer membership, 12 capabilities, and integrity RID 4096. `TokenElevation` reported `true`, but that value does not establish that this process can create a new AppContainer: the process is already inside a low-integrity AppContainer. The OS registry also reports `Windows 10 Home Single Language`, build `26300.9711`, display version `26H2`; this does not establish the requested Windows 11 test environment. The API call's name and string lengths are within the published limits, but the exact cause of its HRESULT is unresolved. The [Microsoft API reference](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile) documents `E_ACCESSDENIED` for insufficient permission and `E_INVALIDARG` for a null or over-limit name/display/description. No elevation or alternate token was attempted.

No contained Core or Worker process ran. Therefore this report contains **no executed evidence** for file or network denial, handle isolation, IPC behavior, child inheritance, crash recovery, Worker A-to-B replacement, or performance. Those code paths are present as experiments to run on a suitable host, but source code and a successful compile do not establish a runtime boundary.

| Prerequisite | Result | Evidence status |
|---|---|---|
| PR-1 — Rust Engine containment | **BLOCKED BY ENVIRONMENT** | Profile creation failed before Core launch; no allow/deny operation ran. |
| PR-5 — IPC and handle isolation | **BLOCKED BY ENVIRONMENT** | Pipes were prepared in the Host, but no child received or exercised them. Full PR-5 remains broader than this PoC. |
| PR-10 — Repairable Worker boundary | **BLOCKED BY ENVIRONMENT** | Neither Worker variant nor the fault Worker ran. |

## 2. Environment and source snapshot

| Item | Captured value |
|---|---|
| OS version API | `10.0.26300.0` |
| Registry product | `Windows 10 Home Single Language` |
| Build / display version | `26300.9711` / `26H2` |
| CPU / architecture | Intel64 Family 6 Model 142 Stepping 12 / AMD64 |
| Rust | `rustc 1.97.1 (8bab26f4f 2026-07-14)` |
| Cargo | `cargo 1.97.1 (c980f4866 2026-06-30)` |
| Toolchain / target | `stable-x86_64-pc-windows-msvc` / `x86_64-pc-windows-msvc` |
| Launcher token | `TokenIsAppContainer=true`, 12 capabilities, integrity RID 4096; `TokenElevation=true` |
| Repository snapshot | Branch `codex/adr-0003-0005-completion`, HEAD `1f54c47fe265c6b47bf36695be56214056fc3af1` |
| Experiment source digest | `d3e1a75d3f1ba166dacf21ba2626d4498425b9e9ad2cb94af1534def18cdf796` |

The OS identity is inconclusive for a Windows 11 acceptance run. The worktree was already dirty when this task began. [`source-snapshot.txt`](../../../experiments/rust-migration-v3/evidence/source-snapshot.txt) records all status paths at the final attempted run (1,066 entries, including this experiment); that number is **not** a pre-existing-dirty-path count. No reset, stash, clean, rebase, commit, or push was performed. This task's edits are confined to the experiment and its two design documents plus the rust-migration documentation index.

The exact build command was:

```powershell
cargo build --release --workspace --offline --locked
```

It completed successfully; the final logged build took 8.92 seconds. The exact launcher path is in [`launch-command.txt`](../../../experiments/rust-migration-v3/evidence/launch-command.txt). The experiment did not invoke `cargo test`, project tests, or the full regression suite. There were no runnable process-level tests after the launch failure.

### Built executable hashes

| Executable | Bytes | SHA-256 |
|---|---:|---|
| `poc-host.exe` | 630,272 | `1dee72937fea775fe22c8e24124a7ff16bb32d26d01ed9b814a79bd6a0745b25` |
| `poc-core.exe` | 784,896 | `0cec6319cf88b36dfe4c0166ac78b8dc9baad2c2661c7aca00e5c68a8888b8e0` |
| `poc-worker-a.exe` | 508,416 | `d6bff17ecf63dcdca166b7227fa80baf8df26cd627cf6470a6bada0f0f31e994` |
| `poc-worker-b.exe` | 508,416 | `166306895b3491eabda6522ab73cdd9a7cc641f416e3a6e50f1ea6935611cbfc` |
| `poc-worker-fault.exe` | 403,456 | `b3e1012babe61367d4047f0ba69fb5fdda591766715e285f94d40dee1e8c4f04` |

The complete hash record is [`binary-hashes.json`](../../../experiments/rust-migration-v3/evidence/binary-hashes.json). The hashes show that A and B are separate binaries; they do not show that either executed or that a replacement occurred.

## 3. Prototype design and boundary

The workspace contains four crates:

- `poc-host`: Windows launcher, profile and Job Object management, fixture setup, one Host/Core channel, Worker launch custody, and evidence writer.
- `poc-core`: protected operation selection, response validation, a small protected state model, bounded request framing, refusal scenarios, and benchmark driver.
- `poc-worker`: two benign normalization/scoring implementations and a separate fault executable.
- `poc-protocol`: shared typed messages; Core and Host do not link the Worker implementation crate.

The intended topology is Host → AppContainer + Job Core → a distinct AppContainer + Job Worker. The Host source configures zero AppContainer capabilities, an explicit inherited standard-handle list, a minimal environment, and Jobs with kill-on-close, one active process, a 256 MiB process-memory limit and a 15-second user CPU-time limit. The Worker is intended to receive only its Core pipe pair and no Host control channel. These are **source-level settings only** until a launched process token and an actual denied operation are observed.

Before profile creation failed, the Host created a synthetic fixture tree, a local TCP listener, a private named pipe, anonymous pipes and the executable hashes. The Core was not launched. The early-failure path now has an exact-path RAII cleanup guard. The prior seven `fixtures/run-<8 hex>` trees from this task were verified as direct, non-reparse directories created during this run sequence and removed. The final failed attempt left `fixtures/` empty. No real Store, Owner Token, provider credentials, active Engine installation, or user project files were accessed.

## 4. PR-1 — Rust Engine containment

**Result: BLOCKED BY ENVIRONMENT.**

| Required behavior | Observation |
|---|---|
| Create the Core AppContainer identity | `CreateAppContainerProfile(d3v37a10e5fed1ffcore, name_len=20, display_len=34, description_len=90)` returned `0x80070057`; no SID was returned. The supplied name is alphanumeric and within the documented 64-character name, 512-character display-name and 2,048-character description limits. |
| Confirm the child token/capabilities | Not run: Core did not start. |
| Core reads/writes only intended fixtures | Not run: no Core process existed. |
| Deny Host-private and workspace reads/writes | Not run. No sentinel denial is claimed. |
| Deny private Host IPC and unauthorized process access | Not run. |
| Deny broader child/grandchild authority or breakaway | Not run. No child process was launched. |
| Job lifetime, termination and reaping | Not run for Core or descendants. |

The Host token probe itself executed and recorded AppContainer membership, 12 capabilities and low integrity. It does not substitute for testing a new Core identity. The error is treated as an environment blocker for this run because the launcher is already inside an AppContainer and could not provision the intended child boundary. The specific API precondition or host policy behind `E_INVALIDARG` remains open; the experiment does not claim that the OS mechanism is infeasible.

## 5. PR-5 — IPC and handle isolation

**Result: BLOCKED BY ENVIRONMENT for the Variant 3 subset.** The source prepares a bounded JSON-lines Host/Core protocol and separate Core/Worker pipes. Host message types use strict typed enums; the source includes size bounds, duplicate request-ID tracking, malformed/unknown message refusal and generation/request correlation. Core source includes refusal cases for unexpected types, malformed and oversized results, stale IDs, forged textual claims, worker errors, and incomplete responses.

None of those interactions ran because there was no Core process. The prepared pipes were not inherited by a child; no actual handle list was inspected; a Worker could not probe the private Host pipe; and no saturation/Stop-responsiveness test occurred. The source has one Host/Core pipe and no separate Stop/control lane. `HostRequest` has no Stop message, and the Host blocks reading that pipe; its hang probe runs only after normal completion. Stop responsiveness is therefore not modeled yet. The PoC also does not establish the full PR-5 contract for concurrent Shell, maintenance, provider, harness and job launches, or removal of all alternate listeners. Those requirements remain separate even if this narrow experiment later passes.

## 6. PR-10 — Repairable Worker boundary

**Result: BLOCKED BY ENVIRONMENT.**

The Worker source contains two useful bounded computations: normalization of synthetic provider-like text and advisory candidate scoring. The Core source is designed to supply the candidate set and validate the result before applying it. The Worker fault binary supports malformed, wrong-request, wrong-generation, forged-claim, duplicate, oversized, incomplete, error, exit, crash, hang and closed-pipe scenarios. This is not execution evidence.

| PR-10 acceptance property | Result |
|---|---|
| Real contained Worker executes useful functionality | Not run. |
| Worker cannot access Host, Engine Store, workspace or ungranted files | Not run. |
| Local network access is denied while IPC still works | Not run. |
| Worker descendants stay bounded or process creation is refused | Not run. |
| Core rejects forged authority and invalid results without state change | Not run. |
| Crashes/hangs leave Core alive and are cleaned up | Not run. |
| Worker A stops and B changes output with Host/Core unchanged | Not run. |
| Reproducible run evidence and timing | Not run; the launcher produced failure diagnostics, not a completed `run.json`. |

The A and B executables have different hashes and Core/Host hashes were captured from one build. No A/B execution or replacement was observed. The Worker’s AppContainer, no-grant policy, dedicated identity, and Job were never created.

## 7. Intended capability matrix and trust in results

The design intent in the prototype gives Host control of process creation and profiles, gives Core only its Host protocol, and gives Worker only bounded Core IPC. Runtime authority is unverified for every child role.

| Data from Worker | Classification | Required protected handling |
|---|---|---|
| Normalized provider records | Pure data | Enforce schema, bounds, allowed fields, completeness and request/generation correlation. Treat parsed status/error information as untrusted input. |
| Candidate scores | Advisory computation | Core fixes the eligible candidate set and enforces policy, floors, budgets and valid transitions independently; Worker cannot add a task or authorize an operation. |
| Prompt/rendered text | Pure bytes with downstream semantic influence | Bound and validate the inputs and output. A model may act on the text, so protected Judge/P2/P5/P6 decisions and protected-role decoding stay outside Worker. |
| Judge, Gate, authorization, scope, Owner, activation or build-acceptance claims | Security-relevant evidence / authorization | Must never be accepted solely from Worker output. Such names remain inert text or are rejected by the protected protocol. |

No Core decision was observed. The code path intends to keep `p2_authorized`, `gate_passed`, `activation_requested`, and `owner_approved` as Core-owned state. That intent is not a runtime guarantee until the forged-claim scenario runs in a contained Worker.

## 8. Crash, recovery, child process and performance evidence

### Crash and recovery

The source has deterministic fault inputs and bounded receive timeouts. None ran. No claim is made that the Core survives a Worker crash, that partial output is not committed, that a replacement cannot reuse stale identity, or that Host cleanup reaps the entire Job. A Host process exit after launch failure is not a Worker recovery test.

### Child processes

The source configures a Job with `ACTIVE_PROCESS=1`, kill-on-close and no breakaway flag. No direct child, grandchild or external executable was attempted. The eventual architecture should keep provider CLI execution in Host custody; this PoC does not establish whether Worker-originated children are needed or confined.

### Performance and operations

No IPC latency, payload throughput, startup/shutdown, p95, maximum latency, working-set, CPU, crash/restart or serialization measurements exist. Executable file sizes above are package artifacts, not resident-memory measurements. The source benchmark driver plans 60 sequential samples at 32-byte, 8 KiB and 64 KiB input sizes; it has no concurrent path or peak-memory measurement. Its local comparison covers normalization plus JSON encode/decode, while the IPC side also includes Core result validation, so those measurements would be illustrative rather than fully equivalent unless corrected. The benchmark was not reached.

The source represents five built executables and, when running a Worker task, Host + Core + one Worker process. Variant 3 therefore adds a process type, profile lifecycle, a second protocol boundary, version/hash binding, restart and crash paths, and protected/repairable copies of any role-sensitive parsing. Variant 1 remains simpler at runtime but leaves the whole Engine under one process authority as described by ADR-0012. The cost comparison is qualitative only; this run supplies no measured operational or performance cost.

## 9. Repairability-by-design assessment

The following are candidate Rust Worker destinations, not decisions to widen the fixed allowlist. The current design’s approximate 1,400-of-25,500-JavaScript-line estimate is an author estimate in document 14, not a target limit or a measured Rust boundary.

| Candidate responsibility | Current source / proposed Worker task | Inputs and outputs | Filesystem/network | Protected decision impact and validation | Self-Repair value / difficulty |
|---|---|---|---|---|---|
| Ordinary provider stream parsing and normalization | `runtime/core/adapters.mjs` (`createParser`, `selectFinal`, ordinary `classifyFailure`) and ordinary mappings in `runtime/core/transport.mjs`; bounded parse/normalize task | Captured, size-bounded provider events → typed ordinary-node records | No direct access; Host/Custody supplies bytes | Can influence ordinary node output and failure classification. Core validates schema/correlation and does not let output authorize P2, Gate or acceptance. Keep a protected decoder copy for Judge, protected Repair Developers and Gate jobs. | High provider-drift value; medium-high split/compatibility difficulty. |
| Ordinary prompt/context rendering | Rendering-only functions in `runtime/core/contextPackage.mjs` and `outputContractText` in `adapters.mjs`; pure render task | Core-validated workflow inputs → bounded prompt text | No Store/workspace access; Core supplies all selected data | Text can shape later model output. Keep Task gating, acceptance evaluation, questions, Judge orchestration and authorization protected; apply output bounds and role restrictions. | Useful for provider/template drift; medium difficulty, higher semantic review burden. |
| Advisory task scoring | Heuristics in `runtime/core/taskAssessment.mjs` (not floors, escalation or limits); score-only task | Core-selected eligible candidates → scores/order recommendation | No direct access | Core fixes candidate eligibility and independently enforces candidate floors, budgets, ceilings and state transitions. Worker may recommend but cannot add or authorize work. | Moderate value; medium difficulty. |
| Provider invocation construction | `adapters.mjs` `buildInvocation`, only if split from discovery and process capture | Provider/model/prompt metadata → proposed argument vector | Worker itself needs no filesystem/network; invocation remains Host-controlled | Arguments can influence an external process. Host/Core must enforce executable, provider role, scope, cwd, configuration and argument policy; no Worker process-launch capability. Start as protected unless validation is fully specified. | Provider drift value; high security and compatibility difficulty. |
| CLI discovery, session environment, capture, Store, task/acceptance gating, limits, Judge decoding | `discoverCli`, `subscriptionEnvironment`, `capture`, `detectProvider`; Store and protected portions of `contextPackage`, `taskAssessment`, `transport` | Not Worker candidates for the initial boundary | Require Host/Custody or protected data/control | Process access, credentials/configuration, filesystem, network, workflow control or security-relevant interpretation. Keep protected; pass only bounded captured data into a Worker. | Not initially repairable under this boundary. |

The practical value is a set of bounded defect classes (ordinary parsing, rendering and advisory scoring), not a percentage of the Engine. A defective ordinary parser may still cause incorrect ordinary output; the protected Core and independent causal/Gate checks must prevent it from authorizing its own repair or acceptance. Protected-role adapter and decoder duplication is an expected cost, not something to optimize away by moving Judge semantics into Worker.

## 10. Variant 1 comparison and compatibility

| Dimension | Evidence-based assessment |
|---|---|
| Security | Unresolved. The intended OS boundary is source-configured, but no child identity or denial was observed. |
| Functional usefulness | Two useful Worker computations are implemented in source and compiled; neither executed. |
| Repairability | Separate Worker binaries and no Worker crate link in Core support a plausible source/runtime split. Independent runtime replacement remains unproven. |
| Complexity | At least one extra process type, OS identity lifecycle, pipe protocol, Worker-specific crash/restart policy, digest/package handling and role-sensitive code duplication. No measured latency or memory cost. |
| Compatibility with P2/P5/P6 and lifecycle | The Core/Worker seam can represent ordinary computations without moving those decisions, but the prototype implements none of the real workflow lifecycle contracts. Compatibility is a design proposition, not an experiment result. |

The Host reduction proposed in document 14 is modest: Host remains responsible for witnesses, scopes, Stop and claim journals, sealing, builds, harness custody, successor continuity and G0; the Engine adds a contained Worker and Worker protocol. This experiment neither demonstrates a material Host reduction nor evaluates the residual OD-12 trust list. It is not a basis for selecting Variant 3.

## 11. Trust-boundary questions

| Question | Current answer |
|---|---|
| Does Worker use Host credentials/capabilities? | Source intends no grants or Host endpoint; runtime unverified. |
| Can Worker issue arbitrary Core/Host operations? | Protocol source has bounded task variants, not arbitrary command strings; runtime unverified. |
| Can Worker output indirectly affect protected decisions? | Yes, ordinary outputs can influence downstream behavior. Protected decisions must not trust Worker claims; validation and independent verification are required. |
| Can Worker access Store or user workspace? | No grant is configured in source; actual denial untested. |
| Can Worker acquire filesystem/network authority? | No capability or explicit grant is intended; actual denial untested. |
| Can a child obtain broader authority or break away? | A single-process Job is configured; inheritance and breakaway behavior untested. |
| Can a Worker crash invalidate Core state? | Core validation/recovery code exists; execution untested. |
| Can A’s response replay as B? | Generation/request checks exist in source; replacement/replay tests unrun. |
| Can Worker source alter protected Core behavior outside the interface? | Cargo/source separation is visible in the workspace, but only a build was observed. Protocol and package binding remain protected design requirements. |
| What still requires broader tests? | All OS denials, handles, descendants, stress/Stop response, actual Worker replacement, crash cleanup, performance, Windows 11 identity, PR-1 grant transitions, full PR-5 topology, P2/P5/P6 compatibility and packaging/custody. |

## 12. Remaining blockers and recommended next run

Run the same isolated workspace from a supported Windows desktop launcher process that is not itself an AppContainer. First capture its token identity and OS edition/build. Do not infer administrator availability from `TokenElevation`; verify the actual token and preserve the no-elevation test requirement. If the same API call still returns `E_INVALIDARG`, isolate its exact argument/precondition in the PoC before treating the platform mechanism as infeasible.

The minimum evidence to continue OD-12 is:

1. Create and clean up a zero-capability AppContainer profile; launch Core and Worker, record distinct token SIDs/capabilities, Job membership and inherited-handle lists.
2. Demonstrate allowed IPC and actual denials for each synthetic Host/Store/workspace sentinel, private Host pipe, process access, and the controlled local network endpoint.
3. Exercise a direct child and descendant under the selected process policy, verify token inheritance and Job cleanup, or record that child creation is intentionally refused.
4. Run valid/malformed/forged/oversized/stale/duplicate/cancelled Worker responses and crash, hang, incomplete pipe and exit scenarios; verify protected Core state remains valid and cleanup is bounded. The source fault worker now drives oversized, partial and exit-before-response cases through Core's receive/decode path; these cases still need an executed run.
5. Run Worker A, stop and reap it, run Worker B, compare outputs and verify Host/Core hashes are unchanged across both launches.
6. Measure small, medium and bounded-large payloads, repeated sequential requests, process startup/shutdown, crash/restart, p50/p95/max latency, serialization, working set and CPU with sample counts.
7. Review the source and reports independently, then complete the separate PR-1/PR-5/PR-10 scope that the PoC cannot cover (Store grant transition, concurrent Shell/provider/harness/job channels, packaging and production custody).

## 13. Independent read-only reviews

### Architecture and practicality

The independent read-only review confirmed that the only executed evidence is the release build and failed profile-creation attempt, and agreed with the **BLOCKED** result. It found the source to be a credible harness outline, while noting:

- A/B are separate binaries from one workspace build; the PoC does not rebuild changed Worker source or verify a separate package/update workflow.
- The direct-child probes do not inspect child tokens, grandchildren or descendant cleanup.
- The protocol has no separate Stop/control lane or saturation test; Host has no Stop request and blocks reading Core’s pipe.
- Initial source-only oversized/partial/exit placeholder checks were not meaningful. The oversized placeholder was removed; the fault Worker cases now exercise the pipe receive path and check per-case Core state preservation, but remain unexecuted.
- The benchmark plan is sequential only, has no peak-memory measurement, and compares IPC that includes Core validation with a local baseline that omits it.
- Package digest binding remains design work; one-build executable hashes are not replacement evidence.

Disposition: retain the **BLOCKED** verdict; address the source-level test gaps and rerun from a verified Windows 11 process outside an outer AppContainer before considering OD-12. This review did not certify runtime security.

### Security and OS containment

The independent read-only security review agreed that PR-1, PR-5 and PR-10 are unproven and the result is **BLOCKED**. Its source review identified these harness issues, which were addressed in the final source before re-review:

- Generic `OpenProcess` and child-launch errors could be mistaken for denials. The probes now require recognized access-denied or Job-limit error codes; unexpected errors fail, and a created/reaped child is `UNPROVEN` until its token and Job membership are checked.
- Filesystem read probes lacked write attempts. Core and Worker now attempt create/write/remove probes only under synthetic fixture directories.
- Oversized, partial-frame and exit-before-response placeholders did not exercise transport. The vector-length placeholder was removed; those cases use the fault Worker pipe path and compare per-case Core state before/after refusal.
- Core and Worker used an undersized fixed `TokenAppContainerSid` buffer. Both now use the size-query/allocation pattern already applied in Host.
- The `direct_rust_child` label did not match the child-probe classifier. Classification now recognizes all `*_child` resources.
- A real delayed response after timeout was missing. A `late_after_cancel` fault now delays and sends the old response, then allows Core to correlate a subsequent request.

The security re-review initially reported that the late-response fault did not answer Core's follow-up request. That concern came from a stale source snapshot: the final compiled `run_fault` includes a `WorkerRequest::Normalize` arm after `Shutdown` and before the fallback, and the delayed-response sequence is coherent.

Remaining source-level limits are explicit: a successfully created child is not checked for token/Job membership, descendants or breakaway/lifetime behavior; Worker resource-probe results are Worker-reported and are not independent evidence against a hostile Worker; Host has no Stop message or independent control lane and blocks on the Core pipe; and no saturation test exists. The architecture and security re-reviews checked the final blocked evidence. None of these points alters the execution result because Core never started. Source review cannot convert an unexecuted OS-boundary test into a pass.

## 14. Final verdict

**`DESZO-RUST-MIGRATION-FEASIBILITY-V3 BLOCKED`**

The release build and launcher diagnostics are reproducible. The current host token and OS identity did not permit this run to reach the required Core/Worker experiments. PR-1, PR-5 and PR-10 remain unproven; no theoretical argument or source configuration substitutes for that missing execution. Keep ADR-0012 Proposed and Variant 1 as the current baseline. OD-12 is not ready for an evidence-based selection.

## 15. RERUN — Windows Desktop Execution

**Task:** `DESZO-RUST-MIGRATION-FEASIBILITY-V3-RERUN`  
**Result:** `DESZO-RUST-MIGRATION-FEASIBILITY-V3-RERUN BLOCKED`  
**Runtime validation:** Pending an ordinary, non-elevated Windows desktop PowerShell launch.

This section records the rerun without changing the prior result in sections 1–14. The first historical attempt ran from an AppContainer and reported `TokenIsAppContainer=true`, 12 capabilities and integrity RID 4096. It did not launch Core or Worker. That result remains the original blocked result; it is not relabeled as an OS rejection.

### Rerun launcher and OS evidence

The new in-process Host preflight reads the token of the executable that would call `CreateAppContainerProfile`. The observed launcher values were:

| Field | Observed value |
|---|---|
| `TokenIsAppContainer` | `false` |
| Integrity RID | `12288` (high) |
| `TokenElevationType` | `1` (Default) |
| `TokenElevation` | `true` |
| Restricted token / restricted SID count | `false` / `0` |
| AppContainer SID / capabilities | none / `0` |
| User SID / session | captured in `launcher-preflight.json` / `1` |
| Ordinary desktop user accepted | `false` |
| Preflight result | **BLOCKED**, exit code `5` |

The process was not already an AppContainer, but it was high-integrity and elevated. It therefore did not meet the required ordinary desktop-user launch condition. The revised launcher now exits before creating fixtures or calling `CreateAppContainerProfile` for an elevated, restricted, non-medium-integrity, AppContainer, or otherwise unverified launcher. No elevation was requested, no alternate token was used, and no security setting was changed.

The OS evidence reconciles the prior ambiguous registry product label:

| Source | Value | Interpretation |
|---|---|---|
| [`RtlGetVersion`](https://learn.microsoft.com/en-us/windows/win32/devnotes/rtlgetversion) | `10.0.26300` | Kernel/client build information |
| Windows product type | Workstation (`1`) | Client rather than server |
| [`GetProductInfo`](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getproductinfo) | `100` (`0x64`) | `PRODUCT_CORE_SINGLELANGUAGE`; this is a SKU label, not OS generation, and matches the registry edition ID |
| Registry | `Windows 10 Home Single Language`, build `26300.9711`, display `26H2`, installation type `Client` | ProductName is inconsistent with the build family; other registry values align with the client edition |
| `GetVersionExW` | `6.2.9200` | Compatibility-context API result; Microsoft documents that the value depends on the manifest/compatibility context and it is not treated as the kernel version |
| `winver` | Not captured | The agent context is non-interactive; operator should compare it in the desktop session |

Microsoft's [Windows 11 release information](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information) maps build `26300.9711` to Windows 11, version 26H2. The kernel/build, product type and release mapping therefore satisfy the requested Windows 11 client target; the misleading registry `ProductName` does not establish Windows 10. The [GetVersionExW documentation](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getversionexw) explains the manifest-dependent version value. The desktop operator should still check `winver` and return its displayed version with the evidence.

### Profile API result and diagnosis

After the initial token probe found `TokenIsAppContainer=false`, one run reached `CreateAppContainerProfile` under the elevated high-integrity token before the stricter ordinary-user gate was added. It returned:

```text
CreateAppContainerProfile(d3v38f1cb3c23aafcore,
  name_len=20, display_len=34, description_len=90)
HRESULT=0x80070057 (E_INVALIDARG)
```

No SID was returned and no Core or Worker was launched. This attempt was not made from the required ordinary-user token, so it does not isolate a profile-argument defect or an OS/policy restriction. The diagnostic category is **`UNRESOLVED`**. Microsoft's [CreateAppContainerProfile reference](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile) lists null/over-limit strings for `E_INVALIDARG`; the recorded name, display name and description are within the published limits. The exact previous attempt is retained in [`attempts/20261106T123050133Z-elevated-token-api-failure`](../../../experiments/rust-migration-v3/evidence/attempts/20261106T123050133Z-elevated-token-api-failure/launcher-failure.txt).

The new Host records UTF-16 termination, lengths, pointer/null state, capability count, HRESULT and SID return state for future profile calls. Once a valid ordinary preflight passes, a repeated `E_INVALIDARG` automatically triggers a separate minimal diagnostic using one fresh harmless profile and null zero-capability pointer; it records the exact HRESULT and deletes only that test profile. The diagnostic has not run because this execution context failed the ordinary-user gate. The earlier `E_INVALIDARG` remains unexplained.

### Launcher changes and prepared runtime checks

The existing PoC and offline workspace were reused. The rerun changes are limited to the experiment and this feasibility documentation:

- `poc-host --preflight` queries AppContainer membership, integrity, elevation type/flag, restriction state, AppContainer SID, capabilities, user SID and session, plus Windows API version/product information. The normal Host calls the same check again immediately before fixture/profile creation.
- `run-poc.ps1` resolves from `$PSScriptRoot`, preserves prior top-level evidence under a timestamped `evidence/attempts/` directory, builds offline, stops on the preflight result, and preserves the child process exit code. It now works with Windows PowerShell 5.1 as well as the available PowerShell Core environment.
- Profile API arguments/results and profile cleanup have structured evidence; the API-returned SID is held by an RAII guard and freed on all launch paths. The minimal null-capabilities diagnostic is prepared but gated on an ordinary desktop token.
- Core and Worker child probes now capture child AppContainer identity/capability count and Job membership when creation succeeds. Host verifies assigned Job membership for each managed Core/Worker process.
- A test-only Host Stop monitor is prepared. At the end of the regular scenario, Core keeps a Worker Job active, reports that Host/Core and Core/Worker IPC were active, then stops reading the ordinary Host/Core channel. A separate Host thread waits 250 ms and terminates the Core Job; Host then reaps the Worker Job and records elapsed cleanup. The source compiles, but this Stop scenario has not executed.

The script was invoked by absolute path from `C:\Windows\Temp`, confirming current-directory-independent resolution. Windows PowerShell 5.1 completed the offline build and preflight, then returned exit code `5` without attempting profile creation. The current [`launcher-preflight.json`](../../../experiments/rust-migration-v3/evidence/launcher-preflight.json) is the exact token/API record; [`environment.json`](../../../experiments/rust-migration-v3/evidence/environment.json), [`build.log`](../../../experiments/rust-migration-v3/evidence/build.log), [`build-exit.txt`](../../../experiments/rust-migration-v3/evidence/build-exit.txt), [`preflight-output.txt`](../../../experiments/rust-migration-v3/evidence/preflight-output.txt), [`preflight-exit.txt`](../../../experiments/rust-migration-v3/evidence/preflight-exit.txt) and [`operator-handoff.txt`](../../../experiments/rust-migration-v3/evidence/operator-handoff.txt) retain the associated run evidence. The source digest at final capture was `a91e7872734f21e7412210657c598146c7d56331f495fd0dce437a33b5d7065c`; the top-level repository snapshot contained 1,174 dirty paths, which is not a baseline count.

### PR results

| Area | Rerun result | Evidence and remaining proof |
|---|---|---|
| PR-1 containment | **BLOCKED** | No Core or profile was created in the gated rerun. No sentinel, IPC, process-handle, child, descendant, breakaway, or denial assertion ran. Live Store-grant transition remains outside this PoC. |
| PR-5 subset | **BLOCKED** | No Host/Core or Core/Worker runtime messages ran. The new stalled-channel Stop code is source-only. Broader Shell/provider/harness/concurrent-launch integration is not covered. |
| PR-10 | **BLOCKED** | No Worker token, resource probe, fault response, crash, hang or recovery scenario ran. Worker testimony still requires independent corroboration where applicable. |
| Worker A → B | **NOT RUN** | No Worker replacement or behavioral output was observed; hashes alone do not prove a replacement. |
| Crash and recovery | **NOT RUN** | No Worker process was launched or recovered. |
| Stop responsiveness | **PREPARED, NOT RUN** | The Host-owned out-of-band termination path is compiled but has no measured runtime result. |
| Performance | **NOT RUN** | No payload, p50/p95/max, startup/shutdown, CPU or working-set measurements exist. |

No completed `run.json` exists for this rerun. The successful offline compile and preflight are not containment evidence. No new independent review was requested: the architecture/security reviews in section 13 predate the rerun source changes, and the requested post-runtime reviews are conditional on real runtime evidence, which is absent.

### Operator handoff and decision

Open an ordinary Windows desktop PowerShell session as the signed-in user (do not use **Run as administrator**) and run:

```powershell
cd C:\my\2026\deszo_agent_orche
.\experiments\rust-migration-v3\scripts\run-poc.ps1
```

The script will archive current evidence before replacing it. If the token preflight passes, it will attempt the existing PoC; if profile creation still returns `E_INVALIDARG`, it will run the gated minimal diagnostic. Return the complete `experiments/rust-migration-v3/evidence/` directory, including the new attempt archive and any `profile-diagnostic.json`, `run.json` and `run-<id>.json`, and include the `winver` display. If file transfer is needed, zip that evidence directory and attach it for analysis.

The overall rerun verdict is **`DESZO-RUST-MIGRATION-FEASIBILITY-V3-RERUN BLOCKED`** because this agent's high-integrity elevated launcher cannot be used for the required ordinary-user experiment. This is an unavailable execution context, not evidence that Windows rejects AppContainer or that Variant 3 is infeasible. Keep ADR-0012 **Proposed**, Variant 1 as the baseline, and OD-12 open. Production modifications: **NONE**.

## CROSS-USER RUNTIME EXECUTION — deszo_poc

**Task ID:** `DESZO-RUST-MIGRATION-FEASIBILITY-V3-CROSS-USER`  
**Result:** `V3 CROSS-USER FEASIBILITY BLOCKED`  
**Runtime validation:** No PoC Host process was started under `deszo_poc`; no Core or Worker process ran.

### Build and artifact selection

The release workspace was rebuilt offline with `cargo build --release --workspace --offline --locked`; Cargo exit code was `0`. The recorded build evidence is archived under [`attempts/20261106T175253360Z`](../../../experiments/rust-migration-v3/evidence/attempts/20261106T175253360Z/). A later `-SkipBuild` pass recorded `cargo_invoked=false`, verified all five release executables against that build's SHA-256 manifest, and confirmed the current Cargo manifests, lockfile and Rust sources still match the selected build inputs. It did not invoke Cargo or rustc.

The current experiment source snapshot is `f9bfaa6bfaad0ef363d82e12b646adbe40706be69d098ae04782bff9aa1fcfdb`. The Host binary includes the new username check for `deszo_poc`. The runner records the execution account and PID, checks the actual Host token, locks the selected executable files against write/delete opens during a run, compares hashes before and after, and returns nonzero for failed or incomplete assertions.

| Executable | SHA-256 |
|---|---|
| `poc-host.exe` | `517b25def99fb45816098c168ab9abb02748c1b8324700a5a1b57222c365b321` |
| `poc-core.exe` | `ca054e0cefe50db8e834f2159f122211289294edabb5a50341cd93cbee114a65` |
| `poc-worker-a.exe` | `c07c41f2070e7e86ca89a2ce6ebcddfed398b5007b04bc781c3ed076b760b808` |
| `poc-worker-b.exe` | `0f9de6193d725df270f98473b4e862933189eef5f5b6a0b71c6819c48f7f8fd4` |
| `poc-worker-fault.exe` | `d518700f2019e920e70133c23dab2c6ce6f10acdc19962ca920a1e002ffcd131` |

### Cross-user launch and token evidence

The `Start-Process -Credential` route displayed the Windows secure credential prompt, but Windows returned “Account restrictions are preventing this user from signing in” and cited blank passwords as one example; no target runner identity record was produced. The Owner then clarified that `deszo_poc` has no password. A subsequent `runas /user:.\deszo_poc` attempt returned exit code `1` without a `deszo_poc` runner record. The runas output did not include a captured diagnostic, so the exact cause of that second failure is not established. The prepared runas helper now resolves Windows PowerShell 5.1 by absolute path; it has not been retried without a working Windows authentication method.

The local account query confirmed that `deszo_poc` is enabled with SID `S-1-5-21-3127887571-659131081-4085854728-1007`. That identifies the account but is not evidence of a process running under its token. The only Host token record in this attempt is the intentional `jusse` gate: username `jusse`, integrity RID `12288`, elevated `true`. It stopped before fixtures and before `CreateAppContainerProfile`. This is not the required runtime token.

No UAC setting, local security policy, account privilege, production Host, Store, enrollment or Self-Repair policy was changed. No password was recorded. The Windows authentication method must produce a real `deszo_poc` process token; a blank-password or policy bypass is not used.

### Test status

| Area | Status | Evidence |
|---|---|---|
| PR-1 Engine isolation | **BLOCKED** | No AppContainer profile, Core process, sentinel test, IPC, process-access test, child probe or cleanup test ran. |
| PR-5 subset | **BLOCKED** | Host/Core and Core/Worker runtime channels, framing, malformed messages, and Stop under stalled IPC were not exercised. |
| PR-10 Worker boundary | **BLOCKED** | No Worker token, resource denial, fault response, crash, hang or recovery test ran. |
| Worker A → B replacement | **NOT RUN** | No Worker was launched; hashes alone do not prove replacement. |
| Crash and recovery | **NOT RUN** | No Core/Worker runtime process was started. |
| Stop responsiveness | **NOT RUN** | The compiled Host-owned termination path has no runtime measurement. |
| Performance | **NOT RUN** | No startup, shutdown, IPC latency, p50/p95/max, CPU or memory values were collected. |
| Independent architecture/security reviews | **NOT RUN** | The requested reviews follow runtime evidence; there is no runtime result to review. |

The latest cross-user launch record is [`cross-user-launch.json`](../../../experiments/rust-migration-v3/evidence/cross-user-launch.json); its unique attempt is [`20261106T181513972Z`](../../../experiments/rust-migration-v3/evidence/attempts/20261106T181513972Z/). The current `launcher-preflight.json` and `result-summary.json` are from the `jusse` preflight only. No `run.json` exists for a `deszo_poc` attempt.

### Decision

The result is **`V3 CROSS-USER FEASIBILITY BLOCKED`** because Windows did not establish a valid `deszo_poc` logon and the actual launcher token could not be verified. This does not establish a failure of AppContainer or Variant 3. To resume, the Owner must provide a Windows-accepted authentication method for `deszo_poc`—for example, set a local account password through Windows and enter it only in the prepared prompt—then the existing `launch-poc-via-runas.ps1` can run the full `-SkipBuild` suite. Do not send the password in chat.

ADR-0012 remains **Proposed**, Variant 1 remains the baseline, and OD-12 remains open. Production modifications: **NONE**.
