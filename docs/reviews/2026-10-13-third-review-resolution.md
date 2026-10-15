# Third Review Resolution — v0.8

Date: 2026-10-13
Source: [third review](2026-10-13-third-review.md).
Scope: the remaining M1 run-state defect and its regression fixtures.
Status: documentation only; application implementation remains unauthorized.

## Selected resolution

Choose option (a): remove waiting_for_user from the M1 run lifecycle, API/filter enums, journal transition enums, database CHECK and active-run index. Reserve that name for the versioned M2 scoped-recovery contract.

The [M1 transition rules](../M1_CONTRACTS.md#run-and-attempt-transitions) own the distinction between run lifecycle and Context review. Failure keeps its draining → failed outcome even when the same attempt puts its binding into needs_review. Root Stop/restart retain canceled/interrupted outcomes. Acknowledgment changes binding readiness for future explicit runs, rather than reopening or pausing the old run.

Continue creation with a non-ready binding is rejected without a run. A binding that becomes unusable before dispatch fails its planned attempt through the ordinary failure policy without launching a CLI. M1 does not invent a user-wait path to resolve either case.

M2 must define reachable user-wait entry/exit transitions, recovery ownership and failure/Stop/restart precedence before extending the [Loop contract](../LOOPS.md#failure-and-recovery). That serialization/state package is now an explicit [milestone prerequisite](../MILESTONES.md#contracts-required-before-each-milestone). The reserved literal is not accepted by core-v1.

## Changed contracts and evidence

- [API schema](../schemas/runtime-api.schema.json), [journal schema](../schemas/journal-event.schema.json) and [reference DDL](../storage/m1.sql) share the eight-state M1 lifecycle.
- [Negative cases](../fixtures/invalid/cases.json) reject the reserved value in run/Stop/filter payloads and both sides of a journal transition.
- [Decision fixtures](../fixtures/decisions.json) cover failure plus native review, rejected Continue creation, ready Continue creation and review discovered before dispatch.
- [SQL cases](../fixtures/sql-cases.json) reject the reserved state, retain needs_review beside a terminal failed run, and allow a new run in that workspace after the old run finishes.
- A positive schema case retains needs_review as a valid Context binding state.

All earlier reviews/resolution notes stay unchanged as historical records. No runtime, frontend, Rust, dependency or prototype test files were edited. The implementation hints in the source review remain guidance for implementation; this patch adds no new implementation blocker from them.

## Validation and readiness

Validation result: `npm.cmd run docs:check` passed with no errors on 2026-10-13:

- 10 schemas, 58 valid cases, 30 structural rejections and 14 semantic rejections.
- 25 decision cases, 29 SQL cases across 13 tables and 2 strict-JSON rejections.
- 245 local links, 25 Markdown files, 2 typed JSON examples, 14 indexed sections and 5 map tasks.

The [offline checker](../tools/README.md) still reads files and uses in-memory SQLite; it invokes no provider and writes no application state. Its decision table is a reference oracle, not proof of implemented scheduler behavior.

This settles the only new M1 blocker identified by the third review. The proposed M1 contract package can be used for an explicitly authorized implementation; this review/documentation update does not supply that authorization. M2–M6 contract prerequisites remain separate.
