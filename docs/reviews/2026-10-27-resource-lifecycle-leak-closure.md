# Resource lifecycle closure — 2026-10-27

**Verdict: `RESOURCE LIFECYCLE VERIFIED WITH LIMITATIONS`**

## Scope and baseline

The checkout was clean at `codex/adr-0003-0005-completion`, HEAD `3357fb08db5fcb2049d37dd54d9781b6a3b7d528`, before these changes. The historical report's estimate of 22 temporary hook directories was not treated as a current measurement.

## Leak A — Branch Delivery hooks directories

Before the fix, `executeBranchDelivery()` created `deszo-empty-hooks-<8 chars>` and, for installed hooks, `deszo-hooks-<8 chars>` with `mkdirSync`. Git received those paths through `core.hooksPath` during clone, checkout, commit, and host ref publication. There was no common release path, so errors and early returns leaked the resources. A failed delivery reproduced one exact leftover, `deszo-empty-hooks-0622d146`, after the operation returned; that reproduction directory was removed immediately.

The operation now owns each `mkdtempSync` directory from allocation through a `try/finally`. Cleanup checks the exact temporary parent, generated name, real-directory type, allocation identity (`dev`, `ino`, `birthtimeMs`) and canonical path before bounded removal. The user hook source is copied into a private directory and is never a cleanup target. Each concurrent delivery gets independent paths.

Git cancellation now waits for the Windows `taskkill /T /F` result and the Git child close. If process-tree termination cannot be confirmed, Branch Delivery preserves both owned paths and appends the actual termination error to result diagnostics. In this sandbox, `taskkill` returned exit 1 with “The user name or password is incorrect”; the regression verified that the path remained present. RL-A05 captures the one hooks path passed to its fetch command and probes a file there with a bounded Node child. After the child closes, teardown removes only that exact captured path; it does not enumerate or sweep the global temporary directory. On a successful termination request, the same test requires the path to be removed.

Windows could not execute the extensionless hook script in this environment: `chmod` left the file mode at `100666`, and Git's trace showed the hook path but not the script body running. RL-A05 uses the production process runner for its bounded child probe instead. A junction replacement test was not possible because the sandbox denied junction creation (`EPERM`); the real-directory substitution case passed and verified that cleanup refuses a changed allocation identity.

The task-specific scratch root contained nine `deszo-empty-hooks-*`/`deszo-hooks-*` directories from earlier failed cancellation attempts before final scratch cleanup. No matching Git, shell, or Node process was present at inspection. The exact task scratch root was then removed; it contained zero such paths afterward. This scoped count does not measure unrelated `%TEMP%` contents.

## Leak B — ControlHost SQLite connection

`ControlHost` opens `host.sqlite` in its constructor before running pragmas, migrations, assurance checks, and recovery. An exception after open prevented construction from returning, so callers could not call `close()`. The existing assurance-mismatch failure reproduced the issue: same-process recursive removal of the fixture failed with `EBUSY` before the fix.

The constructor now initializes `db` to `null` and wraps initialization after acquisition in `try/catch`. On failure it calls the instance cleanup path, records any cleanup error on the primary error, and rethrows the original exception. `close()` attempts ownership release and database close independently, clears `db` after a successful close, and is safe to call repeatedly. The regression confirms the `assurance_mismatch` error and removes the SQLite fixture directory in the same process. The earlier production-capability refusal also confirms that failure before acquisition creates no database.

## Tests and review

- Focused lifecycle selection: 40/40 passed, exit 0. This covered RL-A01–A07, ControlHost constructor and normal-close cases, and smoke cancellation.
- Final RL-A05 cancellation selection: 32/32 passed, exit 0; taskkill denial exercised safe preservation and diagnostics. The fixture removes only its captured operation-owned path after the child closes.
- Test-root cleanup selection: 45/45 passed, exit 0.
- Existing Branch Delivery selection: 42/51 passed, exit 1. Failures were blocked local Git clone/upload-pack operations (`Could not read from remote repository`) and a network-backed helper (`fetch failed`).
- F7 selection: 2/4 passed, exit 1. Both F7 cases stopped in fixture setup because local `git clone` was blocked.
- `npm test`: started through the serialized runner, emitted at least 54 cases, then produced no output for over 12 minutes after native-job tests. Before interruption it reported network failures (`fetch failed`), a native child-tree assertion failure, and an `EPERM` cleanup failure for `jobguard.exe`. The run was interrupted; it has no aggregate total and is not a passing full regression.
- `cargo test --manifest-path lifecycle-host/Cargo.toml`: 9 passed, 14 failed, exit 1. Failures were Windows `Access is denied` during atomic state replacement and a missing symlink privilege.
- `npm run docs:check`: passed, exit 0 (32 schemas; 1,251 local links; no errors).
- `npm run build`: passed, exit 0 (1,763 modules); Vite reported the existing large-chunk warning.
- `git diff --check`: passed before this note; it was rerun after adding this note.

The fresh-context independent reviewer found no actionable issues in the final RL-A05 ownership correction or its description in this note; the reviewer did not run tests.

## Safety and remaining limits

Cleanup targets only operation-created hook directories whose identity still matches the allocation; it does not remove user hooks or repository `.git/hooks`. ControlHost closes only its own `DatabaseSync`; cleanup errors do not replace the initialization exception. No workflow authorization, scheduling, F7 fetch configuration, Process Custody, or test-root framework code was changed.

The Windows sandbox cannot confirm process-tree termination with `taskkill`, so a cancellation can intentionally leave the hooks directories in place and report why. The full `npm test`, Cargo Windows-permission cases, and F7 fixture setup could not be verified end to end in this environment.

## Candidate identity

The source baseline remains HEAD `3357fb08db5fcb2049d37dd54d9781b6a3b7d528`; changes are uncommitted. SHA-256 hashes of the production and regression files at final source review:

| File | SHA-256 |
|---|---|
| `runtime/core/branchDelivery.mjs` | `8F329CF82FA31B1FFA3E9C57F9C2583642123A0869CBB59467283DBDF856097E` |
| `runtime/host/authority.mjs` | `0E27C4DF11A7D63C83A777714E2A1E6488CEF4CC7084529B1492EDDB37CF43C9` |
| `runtime/tests/adr6-regressions.test.mjs` | `6A7F9AE383C47FF31D0988D5A6727A01DCB83EA7192771298AA1EEE0DD6CCE0D` |
| `runtime/tests/branch-delivery.test.mjs` | `03D92984DDDB55C9B8C0A53C69EF2DD9B96475CFF65F0FE4317028E7D5463CB8` |

Changed paths: the four files above and this closure note. Nothing was staged, committed, pushed, reset, rebased, or merged. Historical test artifacts and the original optimization report were preserved.
