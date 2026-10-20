# ADR-0006 second review

Date: 2026-10-20  
Subject: [ADR-0006](../adr/0006-time-bounded-autonomy-and-application-lifecycle.md), as revised after the [first review](2026-10-20-adr-0006-review.md) and its documentation resolution addendum  
Verdict: **The revision resolves R01 to R06 at the architecture level and correctly keeps every mechanism gated until verified.** One new high finding: the "trusted consent" surface is not yet protected against the session's own native UI automation, and §1 still places consent in the candidate window. One medium finding concerns what a service crash does to the controlling application. The complete ADR should stay Proposed until both are decided; the accepted Windows direction (P29) is unaffected.

## Status of first-review findings

| Finding | Status |
| --- | --- |
| ADR6-R01 candidate enforces its own authority | Resolved in design. The LocalService host independently enforces scope, expiry, revocation, identities and budgets; effective authority needs both the host decision and engine validation; the candidate cannot widen it. TCB promotion is gated on actual content and dependency impact rather than path names, and unknown impact fails closed |
| ADR6-R02 credential custody | Resolved in design. Consent, service, controller, launcher and runtime identities are separated. The ADR acknowledges that the runner can mint its own first-party token, so withholding the token from a launcher is not enough, and it keeps controller replacement disabled until the route and credential matrix closes that path |
| ADR6-R03 bootstrap | Resolved by choice: an SCM-managed service with a service SID and a protected interactive Scheduled Task launcher, installed and updated separately. The addendum's factual correction is accepted: [main.rs](../../src-tauri/src/main.rs) assigns the spawned Node runtime to the kill-on-close Job, and that alone does not prove every Deszo-started process is a member. My first review overstated this |
| ADR6-R04 worker privileges | Resolved in design. The tool profile excludes general shell, file and process access as an enforced property, not a prompt instruction. Source repair stays with managed roles, worker model calls are charged separately, the same-user and administrator limits are explicit, and an unenforceable profile is unsupported |
| ADR6-R05 controller versus app under test | Answered. Preview remains the default, and the controlling switch is kept because D26 explicitly requires continuity across a rebuilt Deszo; ADR6-15 makes it the pilot's proof |
| ADR6-R06 smaller points | Resolved. The branch name moved to the status record; reboot no longer trusts old monotonic anchors and a wall clock is only a rollback signal; the pre-migration backup is not treated as a universal restore; UI access is bounded to the authorized app and session |

`npm run docs:check` passes.

## New findings

### ADR6-S01 (high): trusted consent must resist the session's own synthetic input, and §1 still puts consent in the candidate window

The identity table requires "a real user decision through a protected consent surface independent of the candidate". Two parts of the document undermine it:

- **§1 is unchanged.** "Provide an opt-in control such as **Allow autonomous development for 12 hours**" and "The window displays … **Revoke and Stop**" describe the Deszo window, which is the candidate application that the session rebuilds. A candidate build can render or auto-confirm that control.
- **Native UI automation is in the session's own scope.** §5 authorizes desktop input and inspection for UI checks. "Limit input/inspection to the authorized application" is a property of the automation adapter, not an OS boundary. A worker or harness that can send input to the desktop can also click a consent dialog belonging to a separate, independent process. This holds for a dialog on the launcher's tray as well, unless that surface rejects synthetic input. Extension of the policy is a consent operation, so the session could extend its own twelve hours.

Recommendation:

- **Use a surface synthetic input cannot complete.** Consent, extension and scope widening should require an interaction that ordinary-integrity synthetic input cannot complete. Two candidates are a Windows secure-desktop credential prompt and Windows Hello / `UserConsentVerifier` (user verification). Require a fresh one per decision, and record which verification occurred in the authority basis.
- **The Deszo window may only initiate.** It can request consent, show status, and offer Revoke and Stop; revocation needs no protection because it only reduces authority. It must never be the consent surface itself.
- **Rewrite §1 accordingly.** Add a mandatory negative test: synthetic input from the worker or UI adapter cannot complete consent or extension.

### ADR6-S02 (medium): decide what a service crash does to the controlling application

The service must independently stop session-owned work. In practice that means it owns an outer Job containing the launched Deszo, with Deszo's own application and per-run Jobs nested inside. If that outer Job is kill-on-close and the service holds its only handle, an SCM-recovered service crash terminates the controlling Deszo and every run. If it is not kill-on-close, the work survives, but the ADR then forbids the recovered service from adopting it blindly. The ADR currently says only "owned work follows the native containment failure policy" and does not name the policy.

State the chosen policy. For example, kill-on-close is consistent with the no-blind-adoption rule: a service crash is a session Stop, with incident evidence, and recovery starts new work only through fresh authorization. If the alternative is chosen instead, specify the duplicated-handle or re-acquisition protocol that lets a recovered service prove ownership. Add the case to the ADR6-09 tests.

### ADR6-S03 (low): state the expected reboot behavior plainly

After a reboot, automatic continuation requires "a documented basis" for trusted time, and no such source is selected. Windows Time over unauthenticated NTP is not one by default. In practice, then, continuity across a reboot does not happen. Say so in §2 as the default: after a reboot the session is blocked until fresh trusted consent is given, unless a specific trusted time source is later selected and tested. This sets the right expectation for D26, which asks for restart continuity, not reboot continuity.

### ADR6-S04 (low): note on size and the review file

- **The ADR is now very large.** It combines architecture, threat model, protocol obligations and a verification method. That is acceptable for a security-relevant design, but split the Windows IPC/ACL/handle contract and the verification-evidence method into Stage 1 contract documents when implementation starts, so the ADR stays the decision record.
- **The resolution addendum was appended to my first review file.** It is clearly labelled as not an independent re-review, which is acceptable. In future, record resolutions in a separate file so a review file stays one author's assessment.

## Recommendation

Fix ADR6-S01 in §1 and the identity contract, and add its negative test. Decide ADR6-S02. ADR6-S03 is a one-sentence change. After that, the complete ADR is ready for the user's acceptance decision. All mechanisms remain gated by the implementation status record, as they should be.
