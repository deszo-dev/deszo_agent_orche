# P5 Protected Self-Repair — Closure Amendment (P5-CLOSURE)

Date: 2026-10-30. This amends `2026-10-28-p5-protected-self-repair-architecture.md` without changing its history. It
records the contracts added to close the P5-FINAL blockers. The Self-Repair architecture itself (installed v1 verifies
candidate v2, an immutable Lifecycle Host, P3 → P4 → P2 → Gate → Repair Judge → handoff) is unchanged.

## A1. Desktop distribution and its P5 support payload

A desktop (tauri) release is a directory the Rust Lifecycle Host installs as `versions/<buildId>`. It is produced by
`npm run desktop:release -- --source <clean checkout> --out <dir> --build-id <id>` (`scripts/desktop-release.mjs`), after
`npm run desktop:build` built the shell with that build identity. It derives from one clean committed checkout
(`capturedReleaseSource`, shared with the runtime-bootstrap packager). `npm run desktop:build` alone still produces a shell
without a payload, which runs normally with P5 closed:

| Path | Content |
|---|---|
| `deszo.exe` | desktop shell; Host-side, recorded by digest, never repairable |
| `runtime/` | desktop runtime resources; `runner.mjs` is built by the packager from `p5/` (below) |
| `p5/` | the attested runtime source layout plus its shipped dependency closure (the same file selection as a runtime-bootstrap release), and `p5-support.json` |
| `.deszo-source-inventory.json` | committed source inventory, served by the Host for source attestation |
| `build.json` | `bootstrap: "tauri"`, `sourceCommit`, source digest, input digest, every artifact digest, `p5Support` |

Provenance rules:

1. **Clean source.** The checkout must be clean, and its working-tree bytes must equal the committed Git blobs (A5).
2. **Bundle reproducibility.** The Engine bundle is never taken on trust. It is built from the copied `p5/` sources, then
   rebuilt a second time, and the two builds must be byte-identical. `p5-support.json` records the bundle digest. In the
   P5-CLOSURE runs, the bundle built from the payload was also byte-identical to the one built from the development checkout.
3. **Host attestation.** The Host attests the whole release (package digest, source commit, source digest, input digest)
   through its existing `verify_build` / source-release mechanism. No Host change was needed. The Host does not rebuild
   anything, so the source commit and input digest are the packager's measured claims. The packager is part of the trusted
   build base, exactly as for runtime-bootstrap releases. `p5-support.json` records:
   - its toolchain (Node, esbuild);
   - the digests of every desktop resource it copies rather than reproduces (`deszo.exe`, `bridge.mjs`, the Host-side
     bundles, SQL).

   P6 can therefore re-derive or compare them.
4. **Engine admission check.** At admission and around every Gate run, the bundled Engine runs `verifyP5PackageLayout`
   (`runtime/core/p5Support.mjs`). It proves:
   - `p5-support.json` describes the Host-attested running release;
   - the running file is `runtime/runner.mjs` with the reproduced digest;
   - the payload holds exactly the listed files and bytes.

   A desktop release without a payload refuses P5 admission and keeps ordinary operation.
5. **Control root.** `ENGINE_ROOT` (`runtime/core/engineRoot.mjs`) is the release itself for a runtime-bootstrap release and
   `<release>/p5` for a bundled release. The verifier, the protected harness and installed dependencies resolve only there.
6. **TypeScript.** The bundle loads TypeScript lazily from the payload (`p5/node_modules/typescript`) instead of inlining a
   second copy. The test fixture adapters are excluded from the packaged bundle.

## A2. Production causal verification (R(B) / R(C))

A verification policy may declare `causalReproduction: { checkId, baselineMustPass, baselineMustFail }`. The named check must
be required and protected-overlay, and both lists must be disjoint subsets of its assertions. The trusted Gate then:

- **Builds R(B)'s tree.** It materializes `<verify>/execution/.baseline/<checkId>` only from the enrolled baseline source
  objects (the exact installed commit) and Host-scans it.
- **Runs R(B) and R(C) identically.** It runs the same captured command, environment and materialized incident inputs over
  that tree (R(B)), before the candidate check R(C), inside the same Custody-owned verifier invocation.
- **Classifies the baseline run as `reproduced`** only when the JUnit report is complete, every harness assertion passed, every
  defect assertion failed with an assertion failure (`AssertionError [ERR_ASSERTION]`), and the exit code is 1. A load,
  dependency or runtime error, a timeout or a missing case is never reproduction.
- **Issues a passing receipt** only for `reproduced` + R(C) passed + every required check passed. The receipt references a
  `ProtectedSelfRepairCausalReproduction` record that binds:
  - baseline commit and digest, and candidate id;
  - incident outcome and revision, command, inputs;
  - the baseline tree capture and both observations;
  - the dependency closure digest.

  `verifyP5Receipt` requires the record exactly when the policy requires causality, and refuses it otherwise. Earlier
  receipts keep their identities and never gain causal authority.

Admission requires an enrolled policy with `causalReproduction` (`causal_verification`). A production P5 installation
therefore cannot accept a repair whose defect the Gate did not observe on the installed baseline.

## A3. Verification dependency identity

The installed packages the protected subjects import are materialized beside the execution trees. Their identity is fixed in
a `ProtectedSelfRepairVerificationDependencyClosure` record:

- every file path, SHA-256 and size;
- the packages;
- the installed release (build, package digest, bootstrap) and the release's own artifact list (`build.json` or
  `p5/p5-support.json`) against which every file was checked.

The record's canonical bytes live in the verify scratch and are named in the plan by path and digest. The verifier
re-verifies the served dependency files before and after every check, R(B) included, so no check can change what a later
check imports. The receipt binds the record. In-process tampering by candidate code with its own run remains the accepted
cooperative boundary (A7).

## A4. Mutation tiers and the subject closure

One list, `P5_TRUSTED_CONTROL_PATHS`, drives both the Gate's attestation and the `repair-authority` tier, so a trusted
control file can never fall to a weaker tier. The other tiers:

- Engine Custody/adapters/autonomy modules are `engine-custody`, which must include every `repair-authority` check.
  `workspaceIsolation.mjs` and `p5Provisioning.mjs` are in the trusted list.
- Accepted residual (re-review R6): the trusted list is not import-closed. Engine modules the trusted files import (for
  example `planning`, `streams`, `transport`, `mapRuntime`, `taskRuntime`, `shared/effort.mjs`) are `engine-core`. A change to
  one is verified by every check the `engine-core` tier requires, executed over the changed file. It is not verified by the
  stricter `repair-authority` set, and the installed v1 copy, never the candidate, is what runs in the active Gate. Every
  installed file the trusted closure loads is still attested through the Host-served source inventory. Consequence: once
  such a candidate is accepted and later installed by P6, its `engine-core`-verified change runs inside the next installed
  Gate. P6 must therefore re-verify any accepted change to a module in the trusted closure's import graph at the
  `repair-authority` level, or the trusted list must be closed over its imports first (§26 of the closure report).
- Every other shipped Engine input is at least `engine-core`. That covers `runtime/`, `shared/`, `mcp/`, `docs/examples/` and
  `docs/authoring/`; an unknown runtime path is never `ordinary`.
- Generated release outputs (`dist-runtime/`, `dist/`) are Host-protected.

The subject import scanner is an AST walk:
- `node:module` may be imported only for `builtinModules` / `isBuiltin`, and is never re-exported.
- `require`, `createRequire`, `_load`, `getBuiltinModule`, `process.binding`/`dlopen`, dynamic `import()`,
  `import.meta.resolve`, computed specifiers and `vm`/`worker_threads`/`wasi` imports are refused as syntax.
- `eval`, `Function`, computed member access on `process`/`globalThis`, and `globalThis.process` are refused as well.
- `global` is treated like `globalThis`. Indirections are not followed: an alias of `process` in another variable,
  destructuring (`const { binding } = process`), parenthesised or comma owners, `Reflect.get`, the `.constructor` route to
  `Function`. That is inside the cooperative boundary (A7): the scanner
  establishes the recorded closure of cooperative code, not containment of hostile code.
- Text inside strings and comments is inert.

## A5. One byte identity (Windows line endings)

P5's own Git commands always pin `core.autocrlf=false`, `core.eol=lf` and no attributes file, and repository text/eol/filter
attributes are refused. Release packaging now refuses any file whose working-tree bytes differ from the committed blob, as
under `core.autocrlf=true` or an eol attribute. The installed release, the P5 baseline, the managed clone, the candidate
commit and the reconstructed handoff therefore share exactly one byte identity.

## A6. Asynchronous durable publication

`POST /api/v2/runs/{id}/self-repair/publication` only journals the create-only intent (`202`). One executor per Repair runs
it under the Engine, with non-blocking Git:

1. It reads the remote ref.
2. The exact commit present → `published`.
3. Another object present → `conflict`, never overwritten, final for that remote.
4. Absent → it writes `--force-with-lease=<ref>:` only if the Repair is still eligible immediately before the write.
5. It settles by reading the ref again.

`GET` returns `not_requested` / `executing` / `held_uncertain` / `published` / `not_published` / `conflict`. On Engine startup
an open intent is reconciled, never blindly repeated. A recorded success survives a later Stop. A request after Stop is
refused.

## A7. Accepted boundaries

- The cooperative same-user execution model is unchanged. Candidate code under verification runs as the same user, and a
  protected check runs in-process with the candidate it tests (review F19). Two things limit this: R(B) runs only installed
  code, and the dependency closure is re-verified between checks. Nothing here is an OS sandbox.
- Capture holds on transient Host or dependency failures are bounded at 3 durable retries (10/30/60 s), then fail closed
  (`p5_capture_unavailable`). A hold is live work of its Run: the Run stays `running`, Root Stop cancels the held Attempt at
  once, and an Engine shutdown hands the same durable capture to the next Engine. A shutdown is never a Stop: it neither
  spends a hold nor cancels the Attempt, and it waits for an in-flight retry before the Store closes. A Stop already
  requested, or a Run that stopped or drained, is never turned into a hold or retried: the held Attempt is cancelled with a
  reason that names the actual cause. A Stop during an in-flight retry is recorded on the retry; the retry's own authority
  checks (the Stop invalidates the candidate) fail it closed, and anything it left unsettled is cancelled when it returns.
  The hold keeps the Developer workspace locks it took over from the exited process until the hold ends (retry, cancel or
  exhaustion), so no other Agent is scheduled on that workspace while the capture is held; a retry takes the same locks
  back.
- An unproven Developer process tree is not a transient failure. The established Custody contract applies unchanged: the
  Attempt is not accepted and the Repair fails closed. Its workspace stays held until the Host proves the tree ended, and
  nothing is captured, sealed, verified or published.
- The Lifecycle Host stays outside all mutation and activation authority. P5 never builds, installs or activates an Engine
  or a Host.
