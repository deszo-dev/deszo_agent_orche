# Rust migration Variant 3 feasibility PoC

This isolated Cargo workspace tests a protected Rust Core talking to a separately contained, replaceable Rust Worker. It does not change production Host, Node Engine, Store, enrollment, Self-Repair policy, or ADR-0012.

## Components

- `poc-host`: launches the Core and Worker under unique Windows AppContainer profiles; creates one Job Object per process; owns the only worker launch and cleanup capability.
- `poc-core`: protected task selection, typed Host and Worker channels, result validation, a small protected state machine, timeouts, refusal handling, and benchmark driver.
- `poc-worker-a` / `poc-worker-b`: separately built normalization and advisory scoring implementations. B changes whitespace normalization while Core and Host remain byte-identical.
- `poc-worker-fault`: controlled invalid, malformed, duplicate, oversized, crash, hang, and incomplete-result cases.
- `poc-protocol`: the shared typed message schema. Core and Host do not link `poc-worker`.

```text
PoC Host (trusted launcher, user token)
  └─ AppContainer + Job: protected Core
       └─ direct inherited anonymous pipe: AppContainer + Job Worker
```

The Host passes a minimal environment (`SystemRoot`, `WINDIR`) and an explicit standard-handle list. Core and Worker receive no filesystem ACL grants or AppContainer capabilities. The Worker receives no Host control pipe. Host creates Worker IPC pipes and duplicates only the two intended endpoints into the Core process. Each process is placed in a Job before its suspended main thread is resumed. Jobs use kill-on-close, one active process, a 256 MiB process-memory limit and a 15 second user CPU-time limit, with no breakaway flag.

## Run

Requirements: Windows, Rust MSVC toolchain for `x86_64-pc-windows-msvc`, Cargo dependencies already available locally. The script builds offline and never invokes project regression tests.

```powershell
.\experiments\rust-migration-v3\scripts\run-poc.ps1
```

Run the direct script from an ordinary, non-elevated Windows desktop PowerShell session. It works from any current directory, supports Windows PowerShell 5.1, archives prior top-level evidence under `evidence/attempts/<timestamp>/`, builds offline, and invokes `poc-host.exe --preflight`. The Host reads its own token using Windows token APIs and compares `RtlGetVersion`, the compatibility-sensitive `GetVersionExW` result and runner-captured registry values. It stops before fixture/profile creation if the token is already AppContainer, elevated, restricted, not medium integrity, or the Windows 11 client build is not established. This direct script never elevates or changes accounts.

If the normal Host launch returns `E_INVALIDARG` from `CreateAppContainerProfile`, the script runs a separately gated minimal diagnostic using a fresh harmless profile name, short fixed strings and a null zero-capability pointer, then deletes only that exact profile. The call and cleanup are written to `profile-diagnostic.json`; ordinary run profile calls and cleanup are written to `profile-api-calls.jsonl` and `profile-api-cleanup.jsonl`.

The Host creates synthetic sentinels and one local TCP endpoint and private named pipe under the experiment. It removes its exact run fixture directory and deletes the exact temporary AppContainer profiles before exit. A completed run writes `evidence/run.json` and `evidence/run-<id>.json`.

The launcher intentionally requests no elevation. It records the launcher token elevation type, elevation flag, integrity, restriction status, AppContainer identity/capabilities, user SID and session, plus the actual Core/Worker AppContainer identity and Job membership after launch. The API-returned SID is freed on all launch paths. Core and Worker child probes capture child token identity and Job membership when a child is created. The final test leaves a Core/Worker pair alive after the ordinary Host/Core channel stalls; a Host-owned monitor terminates the Core Job out of band and Host custody reaps the Worker Job. These are planned runtime checks and count only after they appear in a completed `run.json`.

The original captured attempt is preserved under `evidence/attempts/`. The latest `jusse` preflight reports `TokenIsAppContainer=false`, but the Host token is elevated and high-integrity, so it stops before profile creation with exit code 5. A separate earlier attempt called `CreateAppContainerProfile` under that elevated token and returned `0x80070057`; the cause remains unresolved and this is not an ordinary-user API result. `RtlGetVersion` reports client build `10.0.26300`, registry build/display are `26300.9711`/`26H2`, while the registry product label says Windows 10 and `GetVersionExW` returns compatibility version `6.2.9200`. The Windows 11 build identity is supported by Microsoft's release mapping, but `winver` was not captured in this non-interactive context. The workspace compiled, but no Core/Worker scenario ran. Do not treat the source or compile result as a containment pass. For the cross-user attempt, see the section below and the feasibility report.

If a prior process was forcibly terminated before its cleanup completed, the fallback cleanup script reads only the AppContainer names recorded in the latest PoC run report and refuses names outside that run's exact prefix:

```powershell
.\experiments\rust-migration-v3\scripts\cleanup-appcontainers.ps1
```

## Evidence files

- `evidence/environment.json`: OS registry identity, Rust toolchain, target, machine and repository snapshot.
- `evidence/launcher-preflight.json`, `evidence/preflight-output.txt`: actual Host token and OS API preflight, with the decision and exit code.
- `evidence/build-exit.txt`, `evidence/preflight-exit.txt`, `evidence/host-exit.txt`: captured native process exit codes when those stages run.
- `evidence/operator-handoff.txt`: next desktop launch command and the files to return when preflight cannot proceed.
- `evidence/source-snapshot.txt`, `evidence/experiment-source-sha256.txt`: HEAD/worktree listing and hash manifest for this PoC's source.
- `evidence/build-command.txt`, `evidence/build.log`: exact offline release build command and output.
- `evidence/launch-command.txt`, `evidence/binary-hashes.json`: launch command and SHA-256 hashes of the built executables.
- `evidence/run-output.txt`: Host output, including the current profile-creation failure.
- `evidence/run.json`, `evidence/run-<id>.json`: positive/negative checks, binary hashes, AppContainer SIDs/capability counts, process and Job configuration, timing, resource cleanup.
- `evidence/launcher-failure.txt`: launch error and host-token diagnostics if the OS boundary cannot be created.
- `evidence/profile-api-calls.jsonl`, `evidence/profile-api-cleanup.jsonl`, `evidence/profile-diagnostic.json`: exact profile arguments/results and exact-profile cleanup, if those paths are reached.

The test protocol and Worker implementations are experimental. They are not production command APIs, and the Worker fault executable is built only for this feasibility workspace.

### Cross-user execution from `jusse`

For the `deszo_poc` runtime attempt, build as `jusse`, then use `scripts/launch-poc-via-runas.ps1`. It invokes `run-poc.ps1 -SkipBuild` through Windows `runas`, records a unique launch result, and holds read-only file handles on the five selected executables while the target runner executes. The Host checks its own Windows token and requires the actual account name to be `deszo_poc`; changing a directory, username environment variable, or launching under `jusse` does not satisfy that check.

Windows did not establish a `deszo_poc` process in the latest attempt. The account has no password, `Start-Process -Credential` returned an account-restriction error, and `runas` produced no target identity evidence. The current result is **`V3 CROSS-USER FEASIBILITY BLOCKED`**; no AppContainer, Core or Worker runtime test ran. See [`15-variant3-feasibility.md`](../../docs/system-design/rust-migration/15-variant3-feasibility.md) for the cross-user evidence and remaining prerequisite. Do not alter UAC or local security policy to bypass authentication.
