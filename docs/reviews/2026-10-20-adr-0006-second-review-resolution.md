# ADR-0006 second-review resolution

- Date: 2026-10-20
- Subject: [ADR-0006](../adr/0006-time-bounded-autonomy-and-application-lifecycle.md)
- Findings: ADR6-S01 through ADR6-S04 from the [second review](2026-10-20-adr-0006-second-review.md)
- Status: Addressed in the documentation contract; implementation/independent verification pending. The complete ADR remains Proposed and P29 still accepts only the Windows architectural direction.

## Scope and history

The request authorizes documentation only. Host/launcher/worker/runtime responsibilities, LocalService/SCM and interactive-task choices, scoped authority, preview default and the necessary controlling-application switch remain intact. No code or Windows configuration, service/task, application, provider call or autonomous session is changed by this resolution.

The [first review and historical addendum](2026-10-20-adr-0006-review.md) and [second review](2026-10-20-adr-0006-second-review.md) remain byte-for-byte unchanged by this amendment. This separate record supplies new dispositions without rewriting either author's findings or claiming a new independent review. The earlier Windows Job generalization is corrected here by reference to the existing addendum and the second review's acknowledgement: [Tauri](../../src-tauri/src/main.rs) explicitly assigns the spawned Node runtime to its Job; that alone does not establish containment of every helper Tauri might launch.

## Disposition

| Finding | Changed contract | Outcome and remaining verification |
| --- | --- | --- |
| ADR6-S01 — trusted consent | Sections 1/2/7/9 make Deszo a consent requester/status/revoke surface. Policy creation, extension and widening require fresh user verification through a protected broker, bound to exact scope and a single-use expiring challenge, with atomic consumption/receipt. Trusted credential enrollment/replacement and independent proof verification are explicit. | An ordinary click or synthetic input cannot supply consent. Hello/WebAuthn remains a mechanism candidate until local Win32, signature/UV, protected-display, fallback, broker identity and synthetic-input tests pass. Missing/canceled/unverified procedure has no normal-button fallback. Eligible work inside valid original authority needs no new consent; authenticated Revoke/Stop remains available without obstructive verification. |
| ADR6-S02 — host failure | Sections 4/5/6/9 select service-owned fail-stop Jobs with kill-on-last-close, service-only outer handles during admitted work and safe pending-launch cleanup. Define owned workload separately from stable controller/infrastructure and unrelated processes. | Test actual service crash during work and before receipt, launcher crash, nested topology, handle inheritance/leak and recovered interruption. A stable preview controller survives while its session-owned attempts/previews stop; an explicitly switched controller may stop with its session. A live outside duplicate must refuse admission or fail the enablement gate, not be counted as a successful kill-on-close test. |
| ADR6-S03 — reboot policy | Sections 2/4/9 preserve valid same-boot application/service restart after reconciliation, but block prior-policy dispatch after an OS reboot in the initial implementation. Fresh first-party consent creates a linked explicit authorization without rewriting old policy/history. | Reboot before/after expiry, changed clocks, sleep/hibernate and service-only/app-only restart tests are mandatory. Existing task consumption carries forward; any larger budget must be explicitly presented and verified. Post-reboot automatic continuity requires a future contract change and independently verified trusted-time mechanism. |
| ADR6-S04 — document boundaries | Section 9 retains architectural invariants and ADR6-01–15 in the ADR. Implementation status identifies gates; verified Stage 1 IPC/ACL, Job/handle and consent/test details can later move to linked implementation specifications. | No speculative specification files or new subsystems are created. Both historical reviews and the existing addendum are preserved; this resolution is separate. Branch context stays in implementation status, not the architecture. |

Acceptance IDs/order ADR6-01 through ADR6-15 are retained; ADR6-01–04, 08–10, 14–15 are strengthened. ADR6-05–07 and 11–13 retain authority, worker, review/Context, UI, data/rollback and shared-limit guarantees. R01–R06 are not weakened.

## Verification gates and falsification

Each test must record initial state, injected failure/schedule, raw observations, exact pass/failure condition and links to its invariant/receipt. Candidate success reports and passing documentation checks do not establish these guarantees.

| Gate | Independent evidence required before enablement |
| --- | --- |
| Consent mechanism and key lifecycle | Service-issued exact decision/challenge; protected display identity/content; trusted credential enrollment/replacement; independently checked signature, audience/client context and UV; atomic single-use consumption and refusal of modified/replayed/self-confirmed decisions. Exercise SendInput/UI Automation, PIN/fallback paths, absent/false broker, cancellation and locked desktop. |
| Native fail-stop | Actual Windows membership/creation identity, Job flags and handle distribution. Kill service during active work and pending launch/receipt; prove exact owned-work termination, stable preview-controller/unrelated survival and no escaped/duplicate child. Deliberately retained duplicates must expose an invalid configuration, not a falsely verified termination guarantee. |
| Recovery and time | Original policy/expiry/revocation and aggregate reservations remain durable across SCM recovery. Same-boot reuse needs reconciliation and new authenticated connections; OS reboot requires fresh verified consent in the initial profile. Preserve interruption/gaps and spent task budgets; never fabricate completion or revive expired authority. |
| Remaining implementation contracts | Scoped bootstrap/route matrix, IPC peer/ACL/proof details, precise native rights/assignment sequence, boot/monotonic source and compatible data recovery still require specification and implementation tests under the accepted threat model. |

No API or physical-input resistance, Job failure/handle guarantee or trusted-time behavior is represented as already tested. The linked [implementation status](../adr/0006-implementation-status.md) owns those pending gates.

## Documentation verification

`npm run docs:check` passed with 28 schemas, 90 Markdown files, 901 local links and zero errors. Criterion numbering remains ADR6-01 through ADR6-15; tracked whitespace checks passed. SHA-256 comparison confirms both historical reviews and the pre-existing adapter change are unchanged. This evidence concerns the documentation edit only; native/runtime tests and feature implementation remain pending.
