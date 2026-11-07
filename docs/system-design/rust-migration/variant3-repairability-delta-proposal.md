# Variant 3 delta proposal — Repairability by Design

**Target document:** `DESZO-RUST-ENGINE-ARCHITECTURE — Repairability by Design` (delta only).

**Status:** Conditional design proposal only. PR-1, the Variant 3 subset of PR-5, and PR-10 remain unproven because the feasibility launcher could not create an AppContainer. ADR-0012 remains Proposed, Variant 1 remains the baseline, and OD-12 remains with the Owner. See [the feasibility report](15-variant3-feasibility.md).

## Proposed architecture delta

Keep the two primary backend services from the current design: the trusted Lifecycle Host and the protected Engine Core. Add one on-demand Rust Worker process for a fixed, default-deny set of repairable computations. The Worker is a third process type, not a third authority. It receives bounded input from Core, has no Host channel, Store/workspace grant, credentials or network permission, and returns untrusted data over one narrow Core-owned protocol.

### Protected Core

Keep the following in protected source and runtime:

- Workflow Scheduler, state machine, node dispatch, lifecycle, recovery and Stop handling.
- P2 authorization, Judge orchestration and protected-role decoding.
- P5 Gate, verification and acceptance control; P6 activation authorization.
- Enrollment, repair policy, source/candidate validation, protected evidence, budgets and limits.
- Store ownership, canonical schemas, Host IPC client and all decisions that can grant authority.

Core chooses the operation, validates input bounds, owns request and generation identities, applies deadlines/cancellation, validates each Worker result and decides whether to use it. Worker output cannot authorize a repair, pass a Gate, approve an Owner action, grant scope, or activate an Engine.

### Initial Worker-compatible responsibilities

Consider only bounded computations whose required data is supplied by Core:

1. Normalize and parse captured output for ordinary provider nodes.
2. Render ordinary prompt/context text from Core-selected workflow inputs.
3. Score or rank tasks that Core has already deemed eligible.

Keep provider discovery, environment/credential access, process capture, file access and provider execution in protected Host/Custody paths. Keep Judge, protected Repair Developer and Gate adapters/decoders in protected code. Keep Task gating, acceptance evaluation, eligibility, candidate floors, budgets, escalation and state transitions in Core. `runtime/core/adapters.mjs`, `transport.mjs`, `contextPackage.mjs` and `taskAssessment.mjs` need responsibility-level splits; whole-file relocation would cross protected decisions.

Worker output is untrusted. Core validates schemas, field bounds, completeness, allowed IDs/values and request/generation correlation. Ordinary output may still affect downstream model behavior, so causal reproduction and protected Gate/acceptance remain independent controls. Pure data shape validation alone is not a semantic security proof.

### Protocol contract to freeze before migration

Use separate typed Host↔Core and Core↔Worker channels. Freeze, protect and version:

- Operation enum, request/worker generation IDs, schema version, bounded frame/payload sizes and deadlines.
- Allowed inputs and outputs for each operation, including normalization and scoring schemas.
- Cancellation, duplicate/stale response handling, deterministic terminal errors and Worker restart semantics.
- A protected refusal path for all unknown operations and fields.

Worker receives no Host command protocol or Host handle. Do not make a shared generic `Command`, arbitrary path, process launch, scope, Store, Gate or activation verb available to Worker. Host Stop must remain responsive when the ordinary data channel is saturated or stalled; define a separate control lane or an out-of-band termination path and test that property explicitly. The current PoC has no Host-to-Core Stop message and does not model that guarantee.

### Build and packaging constraints

- Put Worker implementation in a separately built executable; keep its shell, `main`, manifest, lockfile, toolchain identity, protocol, verifier and packaging code protected.
- Disable Cargo target auto-discovery for the repairable source crate. The fixed installation allowlist should name repairable Worker source paths only and deny manifests, dependencies, build scripts, protocol types, policy and test/harness inputs by default.
- Include Worker bytes in the accepted Engine package and receipt. Host launches only the Worker digest bound to that package; Core and Host digests remain protected.
- A Worker update is part of the normal accepted Engine generation. Do not create an independent Worker update or activation path.
- Keep protected-role parser/decoder copies where output can affect P2, Judge, Gate or acceptance.

### Host responsibilities and migration impact

Host retains profile creation, zero-capability AppContainer setup, handle allowlists, Jobs, executable digest checks, process custody, resource scopes, witnesses, Stop/claim journals, sealing, builds, harness custody, successor continuity and G0. Variant 3 may simplify selected Host-owned admission interpretation under OD-12, but this PoC did not measure that reduction or resolve the residual trust list in document 14 §9.

The migration plan should add a source/runtime split and package receipt for Worker, then gate any OD-12 adoption on executed PR-1, PR-5 subset and PR-10 results. Full PR-5, Store grant transition, provider/Harness custody, PR-9 and the P2/P5/P6 workflow contracts remain separate work. First re-run this prototype from a verified Windows 11 launcher token outside an outer AppContainer; the current blocked run is not evidence for or against the design.

## Recommendation

Keep this delta as a candidate for architecture review, not an approved target. Adopt it only if actual OS denial, protected-result handling, crash cleanup, independent Worker replacement and operation-appropriate performance are demonstrated, and the Owner accepts OD-12's residual trust model. Do not change ADR-0012 or expand the repairable allowlist on the basis of the compile-only evidence.
