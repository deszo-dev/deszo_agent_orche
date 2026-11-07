# ADR-0003 through ADR-0005: resolution of the follow-up resolution audit

Date: 2026-10-16  
Subject: [Audit of the follow-up resolution](2026-10-16-adr-0003-0005-follow-up-resolution-audit.md) (findings A1–A6 and the disposition note).  
Checkout: `main` at `7178032`, with uncommitted implementation changes. Nothing is committed.  
Outcome: A2, A3, A4 and A5 are resolved and covered by the audit's own probes and by module tests. A1 and A6 are fixed in the parts the audit named, with the limits stated below. The earlier claim that F4–F8 were fully resolved is withdrawn; this note is the record that replaces it.

## Verification

| Check | Result |
| --- | --- |
| Audit probe runner ([resolution-audit-probes.mjs](evidence/2026-10-16-adr-0003-0005-resolution-audit-probes.mjs)) | **8 passed, 0 failed**, exit 0. No input digest changed during the run. Report: [after-fix](evidence/2026-10-16-adr-0003-0005-resolution-audit-probes-after-fix.json). |
| Follow-up probe runner ([follow-up-probes.mjs](evidence/2026-10-16-adr-0003-0005-follow-up-probes.mjs)) | **14 passed, 0 failed**, exit 0, after its delivery calls were made to await the async API. No input digest changed. Report: [after-audit-fix](evidence/2026-10-16-adr-0003-0005-follow-up-probes-after-audit-fix.json). |
| Module tests: branch delivery, context contracts, task assessment | **39 passed, 0 failed** (13, 10 and 16 respectively). |
| `npm test` (`--test-concurrency=1`, all `runtime/tests/*.test.mjs`) | **444 passed, 0 failed**, exit 0. |
| `npm run docs:check` | **Passed with no errors**: 27 schemas, 81 Markdown files, 806 local links. |
| `npm run runtime:bundle` | Passed. The bundle keeps `deszo-launch-shim.exe` and includes `m10.sql`. |

The negative reproducer ([negative-probes.mjs](evidence/2026-10-16-adr-0003-0005-negative-probes.mjs)) is a diagnostic. It records observations and has no assertions and no pass/fail counter, so its exit code is not a verification result. Its earlier "14 passed" wording is withdrawn. It now awaits the async delivery call, so its observations are current.

## Disclosed changes to the audit's probes and runners

- `resolution-audit-probes.mjs`, probes 2 and 3: they now pass the authoritative inputs (`expectedBoundary` and `resolveEvidence`). Before, they failed only because required inputs were missing, so they did not test the matching logic. Probe 2 adds an identifier-and-digest record, which must be refused as incomplete. Probe 3 resolves a complete engine record of the wrong kind, subject, candidate and outcome.
- `resolution-audit-probes.mjs`, store upgrade: it no longer rebuilds m9 from the current file. It opens a store with the earlier m9 (`steps.slice(0, 9)`), reads the key, and then asserts the same final key after upgrade.
- `follow-up-probes.mjs` and `negative-probes.mjs`: the delivery calls are awaited and the probe bodies are async. The assertions of the follow-up runner are unchanged.

## Findings

### A1 — Asynchronous execution: partially resolved

Changed (`runtime/core/branchDelivery.mjs`): `executeBranchDelivery` is an async function. The `wrapResult` thenable is removed. Every Git, smoke and commit step is an awaited child process (`runProcess`), so the event loop runs while delivery works. Each child is bounded at 16 MiB per stream. A timeout or an abort kills the child tree (`taskkill /T /F` on Windows, the process group elsewhere) and resolves after a 2 s grace.

Stop: `executeBranchDelivery` takes `signal` (an `AbortSignal`). An abort during clone, checkout, staging, smoke, commit or fetch returns status `stopped`, with `refUpdated: false`, and the ref is not published. The abort is checked again after the fetch and immediately before the host ref update.

Measured by probe `control_callback_must_run_before_smoke_ends_and_ref_is_published`: the call returns in 30 ms with the ref unpublished. The callback fires 79 ms after start, while smoke is still running. Smoke ends about 1.1 s later, and the ref is not published at callback time. Module tests cover a callback during a 1.5 s check, and a Stop that terminates a 60 s check and leaves the ref absent.

Not done, so A1 remains open for these points:

- **Run-owned supervision.** Delivery children are not launched through the engine's contained launcher (the Job-object path). Delivery is not dispatched by the engine yet (R1 integration is deferred). Tree termination is best effort, so a descendant that leaves the tree is not contained.
- **Aggregate accounting.** Process count, output bytes and durations are not recorded.
- **Smoke output truncation.** Truncation is reported only for candidate blob comparisons. Smoke diagnostics can be cut at 16 MiB without a flag.
- **Per-check `timeoutMs`.** The code reads it, but the delivery-plan schema does not allow it, so valid plans always use the 30 s default. This is an existing gap between code and contract; this change does not widen the contract.
- **Publication cancellation.** A Stop is honored up to the start of the `update-ref` call. The update itself is atomic and is not interrupted.

### A2 — Authoritative Gate evidence: resolved in the evaluator; no resolver is wired

Changed (`runtime/core/contextPackage.mjs`): `evaluateAcceptanceRecord` opens a Gate only when given all of these: a non-empty `expectedCriteria`, `expectedBoundary`, `expectedSubjectId`, `expectedCandidateDigest`, and `resolveEvidence(ref)`, a function owned by the engine. Without them the result is structural: `valid: true`, `canOpenGate: false`, and the missing inputs are named. The `knownEvidence` and `resolvedEvidence` collections (Set, Map, array or object) are no longer read.

Each satisfied reference must resolve to a record that passes `RESOLVED_EVIDENCE_SCHEMA`. That schema is complete and requires `source: 'engine'`. The record must match the reference's id, kind and digest, the expected subject, candidate digest and boundary, the criterion it applies to, and the required outcome (`passed` for checks, `recorded` for other kinds). A resolver that throws refuses the Gate.

Verified: the three audit probes, and the module test "A2: authoritative evaluation requires complete engine records…", which covers ten refusal cases, a throwing resolver, a collection passed in place of a resolver, and one positive case.

Limits:
- No engine resolver exists yet, so no current runtime path can open a Gate. That is consistent with Gate integration being deferred.
- The record contract lives in code. It should move to a documented schema when the engine integration lands.
- The trust boundary is the resolver function. The evaluator cannot verify that the resolver reads immutable storage, so the engine must own that function.

### A3 — Host ref publication under hooks:none: resolved

Changed: the host-side `fetch` and `update-ref` always run with `-c core.hooksPath=<empty directory>`, whatever the hook policy. Installed hooks run only inside the isolated clone (clone, checkout, add, commit), as before. The hook receipt says host ref publication runs with hooks disabled.

Verified: probe `hooks_none_must_also_cover_host_ref_publication` and the module test "A3: hooks:none covers host ref publication…". This is a deliberate policy: a host repository's own hooks never run during delivery.

### A4 — Atomic revision persistence: resolved

Changed (`runtime/core/store.mjs`): `Store.recordExecutionPlan` runs in one transaction covering the artifact write, the lookup, the supersession and the insert.
- An identical retry (same revision id and artifact) returns the original receipt with `replayed: true`.
- A different document under an existing revision id throws `already stored with different content`, and the active revision is kept.
- A failed insert rolls back the supersession that preceded it.

Verified: probe `failed_revision_retry_must_preserve_the_active_revision`, and the module tests "A4" (three cases, including the CHECK-constraint rollback).

### A5 — Existing m9 stores: resolved

Changed:
- `docs/storage/m9.sql` is restored to the definition an existing store applied, with `id TEXT PRIMARY KEY`.
- The new append-only `docs/storage/m10.sql` rebuilds `execution_plans` with `PRIMARY KEY (id, plan_revision_id)`. It copies every existing row and recreates the two indexes. A store that already applied the composite-key m9 migrates safely, because the rebuild copies its rows too.
- `MIGRATION_PATHS`, the bundler and the migration-count test (now 10) include m10.

Verified: probe `opening_an_existing_m9_store_must_upgrade_the_plan_revision_key`, and the module test "A5…", which seeds a store at the earlier m9, reopens it, and checks that the revision is kept and a second revision can be added.

Note: m10 drops and renames a table that has no inbound foreign keys. If one is added later, the rebuild must be revisited.

### A6 — Recheck before publication: partially resolved

Changed: the preconditions (active checkout in the host or any linked worktree, moved target, base mismatch, missing base) are one function, `publicationPreconditions`. It runs before preparation and again immediately before the host fetch. A checkout made during smoke is refused with `precondition_failed`, and the caller's checkout stays clean.

Verified: probe `checked_out_target_must_be_rechecked_after_smoke` and the module test "A6…".

Limit, as the audit asked to be stated: a checkout that starts after the final re-check and before `update-ref` is an external race. The ref update is a compare-and-swap on the expected old value, so it cannot overwrite a moved ref. It cannot stop a checkout from taking the target. Callers must not check out a target branch while a delivery is pending.

## Remaining open items

- A1: run-owned supervision, aggregate accounting, smoke-output truncation flag, and the per-check `timeoutMs` contract gap (above).
- Gate integration: an engine resolver, and a documented evidence-record schema (A2).
- The negative reproducer remains a diagnostic with no pass/fail claim.
- No commit has been made. The changes are untracked and modified files in the working tree.
