# ADR-0012: Rust-First Backend and Autonomous Engine Lifecycle Architecture

- **Date:** 2026-11-06 (Europe/Moscow); revised the same day after the independent architecture and security reviews.
- **Status:** Proposed. Not accepted; requires Owner approval. Nothing in this record is implemented.
- **Scope:** backend technology, process and trust architecture, protected Self-Repair authority, resource scopes, persistence compatibility and migration. Documentation only.
- **Design documents:** [Rust migration system design](../system-design/rust-migration/README.md) (documents 01-13); [finding register](../system-design/rust-migration/12-finding-register.md).
- **Reviews:** [architecture review](../reviews/deszo-rust-migration-architecture-review.md) and [security review](../reviews/deszo-rust-migration-security-review.md), both BLOCKED on the first version; remediated in this revision.
- **Related:** [ADR-0008](0008-portable-ephemeral-lifecycle-host.md), [ADR-0009](0009-workflow-native-judge-and-exclusive-external-input.md), [ADR-0010](0010-p6-trusted-build-activation-rollback.md), [ADR-0011](0011-engine-runtime-containment.md). Their statuses are unchanged by this record.

## 1. Context

Deszo's backend is a Node.js Engine (`runtime/runner.mjs`, `runtime/core/*`, about 25,500 lines) that serves the public API, owns the Store and the Owner Token, runs workflows, and contains the P5 Gate and the P6 consumer and builder. A Rust Lifecycle Host (`lifecycle-host/`, about 7,800 lines) owns installation, process lifecycle, custody and the G0 Engine switch. The Tauri Shell hosts the UI.

Recorded findings ([Decision C design](../reviews/2026-11-06-p6-decision-c-design.md), [R10 report](../reviews/2026-11-05-p6-r10-close.md)): repairable Engine code reached the Host's stage and switch commands and a test-owned Host switched Engines without P5; one Host capability authorized every command family; same-user Engine children reached the Store and the Owner Token; in-process controls did not establish capability separation; acceptance evidence lived in a Store the Engine writes; AppContainer isolated contained children on Windows, but loopback is unavailable to them and Node ESM was not shown.

## 2. Problem

The repairable Engine must not authorize, construct trusted evidence for, or execute its own privileged installation, while Deszo keeps autonomous Self-Repair (A → B → C without per-update Owner approval or Git push), the existing P2 authorization and P5 acceptance contracts, and all workflow behavior and data.

## 3. Owner decisions in force

- All backend and system logic in Rust; JavaScript and TypeScript only in the Tauri frontend UI; no Node.js backend runtime.
- Full Access means full operational access to the explicitly authorized resources of a Workflow, not unrestricted access to the machine.

## 4. Considered alternatives

| Alternative | Outcome |
|---|---|
| A: Rust Host with Admission, contained Rust Engine | **Selected** |
| B: Rust Host, Trusted Control process, Rust Engine | Rejected for now: no authority benefit; possible fault-isolation benefit is unmeasured; adds a protocol and reconciliation. Reconsidered on evidence from the Host-reliability tests |
| C: single binary or merged roles | One Engine binary with a maintenance mode adopted; Host and Engine in one binary rejected; Host and Shell merge not adopted |
| A-S: Host as a separate OS account, Engine uncontained | Rejected |
| Complete Node + ADR-0011 | Not selected by the Owner decision |

Details: [08](../system-design/rust-migration/08-alternatives-and-tradeoffs.md).

## 5. Decision

### 5.1 Processes and enforcement

- Two backend processes: `deszo-host` (trusted, user token) and `deszo-engine` (repairable, per-build AppContainer principal, no workspace grant). The Shell is the frontend.
- Every Run executes under a Host-issued scope in its own principal; verification, harness, build, seed and export jobs and each protected Judge invocation have their own principals. Launches fail closed.
- The Host spawns the Engine directly and talks to it over inherited pipes with a closed, typed, laned message set. The channel identifies the principal. No stage, switch, fence, attach, acceptance, build, enrollment or binding message exists; every child-reachable legacy entry point is removed.

### 5.2 Trusted computing base

The Host (lifecycle, G0, Store guard, custody, sandbox, scopes, gateway, Admission; about 15,000-17,000 lines as a sizing hypothesis), the Shell, the `deszo-protocol` crate, `deszo-mcp` and the `deszo-harness` binary, all maintainer-released. Host fault limits are stated, not assumed (bounded parsing, quotas, control lanes, panic handling; no claim of full in-process isolation).

### 5.3 Repairable components

`deszo-engine`, `deszo-workflow`, `deszo-store` (code; migrations, runner and catalog protected), `deszo-providers`, `deszo-git`. The Engine owns workflows, publications, Runs, scheduling, providers, the mandatory Judge node, P2 coordination, supervision and ordinary API semantics.

### 5.4 Protected Self-Repair authority

- **P2 authorization (separate stage).** The gateway registers Parent Runs started by the Owner for the enrolled Parent publication. Parent attempts run under the registration through custody. When the Engine reaches the Parent's Judge node, the Host launches the designated Parent Judge with a Host-built dossier and captures its decision. `request_repair` on a pinned profile, bound to the failed node attempt of that registration and followed by a reproduction of the incident on the baseline from Host-held inputs, yields one `RepairAuthorization` per incident, consumed atomically with the claim of the generation's own slot. The P3 outcome category stays an Engine label; the baseline reproduction is the trusted observation that stands in for it.
- **P5 acceptance (separate stage).** The Host seals the candidate (parent must be the slot's seed), recomputes identity and applies the protected-path policy. The Gate and the acceptance Judge run only on asynchronous checkpoint delegations at the enrolled nodes and new Attempts; a failed Gate or a `reject_repair` is terminal for the authorization; acceptance requires delivery of the complete required review set. The causal check keeps the P5-CLOSURE A2 standard through an enrolled, out-of-process harness. Protected questions are Host-rendered and answers Host-validated.
- **P6 activation.** After acceptance and the Engine's completion report, the Host checks and seeds the ordered successor slot, writes a `BuildIntent` (build ID derived from it), builds twice in sealed offline jobs, collects outputs safely, writes `BuildReceipt/2`, journals the eligibility cutoff at Engine A's drain acknowledgement (the same cutoff as ADR-0010 §5), records `switch_prepared` (a blocked cutoff or a pre-commit failure records `switch_abandoned` and A resumes), commits the selector and derives the successor enrollment. B preflights under its own per-build principal with access to the copy only; the Store grant moves to B after commit.
- **Recovery.** One protected journal plus the selector; projections rebuilt from them; idempotent replies; explicit retries with fresh identities.

### 5.5 Workflow-scoped Full Access

Owner-authenticated resource bindings and publication resource policy, witnessed by the gateway; Host-issued Run scopes only for gateway-witnessed Run starts or Host-recorded derivations (an ordinary Repair from its pinned profile's non-overlapping binding; other children never wider than their parent); an Owner Stop ends a Run's scope; per-Run principals with capability grants applied once per binding; overlap and alias refusals; revocation at the next launch; legacy publications and workspaces receive scopes only after the Owner confirms them at cutover.

### 5.6 Persistence, API and credentials

The Engine Store stays in place: same migrations, semantic imports, raw digests and canonical JSON. The Rust Engine takes the existing `runner.lock.db` lock during coexistence. The Host keeps a separate protected store. The gateway preserves per-route wire semantics, streams raw artifacts, and validates protected Stop and answers. The Owner Token keeps its authority, moves to the Host, and is **rotated at cutover**; clients rediscover through descriptor version 2 and `deszo-mcp`.

### 5.7 Migration strategy

M0 freezes behavior and the authority contracts; M1 runs PR-1 to PR-9 (and PR-10 if Variant 3 of §10 is pursued); protocol and Store; Host restructuring with test packaging; Engine primitives and parity beside Admission; P6 activation and genuine E2E; production packaging and a journaled cutover with a checkpoint and bounded downgrade; Node removal. No shipped configuration mixes a Node Engine with the new authority model.

## 6. Consequences

### 6.1 Security

- No Engine message can cause staging or switching, start a protected Repair without a Host-issued authorization, or advance a protected stage without a Host observation.
- Acceptance and authorization evidence is created by trusted code and stored where no contained principal has a grant.
- The Engine holds no workspace grant; Runs are mutually isolated by principal.
- The Owner Token never enters a contained process, and the possibly exposed Node-era value is retired at cutover.
- An accepted wrong candidate gains only contained Engine authority.
- Trust in the pinned enrolled Judge executables is an explicit Owner decision (OD-10). The semantic correctness of Judges and tests is outside what any mechanism proves.

### 6.2 Operational

Admissions take longer (harness runs and several Cargo builds); installations carry a pinned toolchain, vendor set and harness; registering a workspace adds capability entries to its access control list once; old MCP registrations must be regenerated at cutover; Linux and macOS are supported design targets, not implemented.

## 7. Relation to ADR-0010 and ADR-0011

| Item | Disposition |
|---|---|
| ADR-0010 automatic activation after eligible P5 acceptance, no per-update approval | Remains valid |
| ADR-0010 one atomic `active.json` commit, durable switch journal, custody fence, guarded disposable-copy preflight, pre-commit fallback, no post-commit rollback, Host and Shell immutability | Remain valid and are reused |
| ADR-0010 P2 eligibility of the handoff (exact Parent authorization, Stop and invalidation before the final transaction) | **Remains valid**; witnessed by the Host instead of read from the Engine Store |
| ADR-0010 §4 Engine A owns P5 validation, reconstruction and build orchestration | **Superseded**: Host Admission |
| ADR-0010 §5 Engine A's final switch request | **Superseded** by the drain acknowledgement; the eligibility cutoff stays at the same point and is journaled by the Host |
| ADR-0010 §6 Shell loads the runner from `engineRoot` | **Superseded**: the Host spawns the Engine directly |
| ADR-0010 §7 `P6Operation/1`, `P6BuildReceipt/1`, `build.json` schema 2 | **Amendment required**: admission journal, `BuildIntent/1`, `BuildReceipt/2`, `build.json` schema 3 |
| ADR-0010 §8 same B process continues after commit | **Kept** through a per-build principal and a commit-time Store grant transition; OD-9 applies only if the transition cannot be bounded |
| ADR-0010 §9 Engine-side P5 continuation reader | **Superseded**: Host-derived successor enrollment and successor seeding |
| ADR-0010 §10 trusted builder runs no candidate code | **Amendment required**: Cargo builds run code, so builds are sealed, contained jobs |
| P5-CLOSURE A2 causal verification | **Remains valid**; implemented by the enrolled out-of-process harness |
| ADR-0011 C1-C4 | **Superseded**: no authority lives in the repairable process |
| ADR-0011 §9 Decision C requirements | Retained; the separate Control Process and keyed shared-Store records are superseded by Host Admission and a Host-only store |
| ADR-0011 §9.7 missing guarantees | Carried forward as PR-1, PR-5 and PR-8, restated for a Rust Engine |

Historical ADRs are not changed by this record.

## 8. Open prerequisites and decisions

PR-1 to PR-10 (PR-10 only under Variant 3 of §10) and OD-1 to OD-15 as defined in [09](../system-design/rust-migration/09-open-decisions.md). PR-1, PR-5 and PR-8 block the Host restructuring; PR-2 blocks each provider's managed use; PR-3, PR-6 and PR-9 block Admission; PR-4 and the PR-1 grant transition block P6 activation; PR-7a blocks the Store layer.

## 9. Acceptance criteria for this record

1. The Owner approves the selected architecture and decides OD-1 to OD-15.
2. Fresh-context architecture and security re-reviews of this revision find no unresolved design-breaking issue, with dispositions recorded in the finding register.
3. PR-1, PR-5 and PR-8 pass on Windows 11 before the Host restructuring begins.
4. Implementation acceptance follows [10](../system-design/rust-migration/10-implementation-roadmap.md), ending with the packaged genuine A → B → C, exhaustion and restart runs and the full Rust regression on one frozen snapshot.

## First-version section map

The independent reviews link to section titles of the first version. Each title below names where that content is now.

### 3. Owner technology decision

Now §3 (Owner decisions in force).

### 5.4 Self-Repair model and Host admission authority

Now §5.4 (Protected Self-Repair authority).

## 10. Proposed revision under consideration: protected Engine Core (pending OD-12)

The Owner decided that only a fixed, default-deny subset of the Engine source is repairable and that the scheduler and the whole Self-Repair control path are protected. [Document 14](../system-design/rust-migration/14-self-repair-scope-reconsideration.md) assesses the consequence; two fresh-context challenges blocked its first version, and the revision follows their findings.

- Source immutability alone does not protect runtime behavior. Compile-time confinement in the Engine process does not either: `extern crate std;` re-enables I/O in a `no_std` crate, and safe-code soundness exploits exist. That variant is rejected.
- Variant 3: all repairable code runs in a separate component worker, an OS-contained process with no grants (PR-10). No protected decision consumes its output without a trusted check, so the repairable region is ordinary provider adapters, ordinary rendering and assessment scoring.
- Under Variant 3 the protected Engine Core keeps P2, the Gate classification, acceptance and Owner questions, as today. The Host keeps the Run-start, binding and publication witnesses and scopes, the Stop and claim journals, sealing and policy at capture, builds before the Gate, the harness against the built package, the custody Judge profile, the successor and G0.
- Residual the Owner would accept (14 §9): a compromised Engine principal could decide P2 without a genuine incident, misclassify the causal run, record a false acceptance, relabel a protected question, or misname the Repair Run; it cannot change protected source, the policy, scopes, the Host, the Shell or the Owner Token, ignore a Parent Stop, or skip the Host build and harness run.
- Contract limitations found: no Judge attention after a terminal Repair outcome (OD-13) and a capture anchor that precedes the boundary check (OD-15).

Decision required: OD-12, after PR-1 and PR-10. Until then sections 5-9 (Variant 1) remain the proposal of record, with the default-deny policy of 14 §8 required in either variant.
