# Deszo development pilot: shadcn/ui migration

Status: agreed business input and role assignments; workflow execution and UI migration are pending.

## Business task

Move all Deszo application panels, forms and dialogs to shadcn/ui. Preserve the current capabilities and workflow behavior, including React Flow editing, execution controls, recovery, history, Replay, Context chat and API/MCP authoring synchronization. Use the existing English product language.

The result is a separate local feature branch, `codex/shadcn-ui`, with the UI changes, relevant tests and documentation. Because `codex/shadcn-ui` already exists on origin and carries the ADR-0002 implementation commit, the delivery starting point before pilot execution must either:

1. explicitly accept the current head of `codex/shadcn-ui` (which includes the ADR-0002 commit and explicit-effort baseline) as the captured base commit to advance under an expected-ref condition; or
2. designate a fresh delivery branch from `main` (such as `codex/shadcn-ui-migration`), recording the branch absence condition.

Record the starting commit and the selected candidate before applying results. Merge and release remain separate actions.

## Roles

| Role | Provider | Model ID | Effort | Responsibility |
| --- | --- | --- | --- | --- |
| Analyst | Codex | `gpt-6.1-sol` | `max` | Receives the original business task first; writes requirements, acceptance scenarios and the implementation map; decides changes to requirement meaning; checks the complete business task at the end. |
| Code reviewer | Claude Code | `claude-opus-5-5` | `medium` | Checks requirements for implementation feasibility and interface preservation; reviews production code and implementation-documentation consistency; routes code defects to the Developer. |
| Test reviewer | Claude Code | `claude-opus-5-5` | `medium` | Independently checks requirement testability, acceptance cases, test coverage, assertions, fixtures and actual test/UI evidence; routes test defects to the Test author. |
| Test author | Claude Code | `claude-haiku-5-5` | `xhigh` | Writes tests against approved requirements and interfaces, then repairs test defects. |
| Developer | Claude Code | `claude-haiku-5-5` | `xhigh` | Implements bounded tasks and repairs code defects. |
| Junior analyst | Codex | `gpt-6-luna` | `max` | Applies scoped documentation corrections and maintains examples and references. Changes to requirement meaning go back to the Analyst. |

The user confirmed separate code and test reviewers, both using Opus 5.5. Their existing `medium` effort is retained explicitly. The user confirmed `xhigh` for both Haiku roles and `max` for Luna. The two reviewers have separate role IDs, Contexts and task directories, with independent decisions. Each executor also has its own Context and task directory. Model access is checked before the first real pilot invocation; the names in this brief are not evidence of account access.

## Preparation and execution

1. The Analyst inspects the current UI and records an inventory of panels, forms, dialogs and application-owned controls, then produces `SPEC.md`, `spec-index.json` and `implementation-map.json`.
2. The Code reviewer checks completeness, interface preservation and implementation feasibility. The independent Test reviewer checks testability and acceptance coverage. Both must approve the same specification before implementation. The junior analyst applies documentation corrections; substantive decisions return to the Analyst. Recheck the affected requirements before implementation.
3. Pin the approved specification and project snapshot. The test author and developer work from the approved interfaces in separate task directories. Shared dependencies and files must have an explicit order or a single owner in the implementation map.
4. The Code reviewer reviews implementation tasks; the Test reviewer reviews test and evidence tasks. Mixed code/test tasks need both reviews. Assemble the selected results and run the approved checks on that exact candidate. Findings return to the responsible executor. Bound repair cycles and pause on an unknown cause.
5. Update the documentation and require both independent final technical reviews before the Analyst checks the original business task against the assembled result and actual evidence. Apply the accepted candidate to the feature branch with a recorded diff and rerun the relevant checks there.

The stable Deszo installation controls the pilot. Development/runtime previews use separate data directories. Prepare Node dependencies and approved temporary/report paths in task/check directories before verification; the small reference delivery example does not establish this setup for the full Deszo repository.

## Acceptance scope

- The UI inventory covers the palette and application toolbar; workflow overview and node inspector; Map role editor and navigator; run, issue and Context panels; recovery controls; history and Replay; settings, workspace and workflow dialogs; external-run confirmation and Context chat.
- Application-owned buttons, inputs, selectors, dialogs, tabs and status surfaces use the agreed shadcn/ui components and shared theme tokens. Keep the React Flow canvas, port connections, selection, zoom/pan and nested navigation functional.
- Preserve save/load, validation, dirty-state handling, editor synchronization, run/stop/retry, task limits, Context behavior and all current configuration options, including reasoning effort.
- Verify keyboard navigation, labels, visible focus, dialog focus handling, disabled/busy states, error states and small-window overflow on the affected surfaces.
- Run the frontend build, appropriate runtime/contract regression checks and documentation checks. Add meaningful UI interaction coverage for the changed flows using the fixture runtime. Record browser screenshots and a desktop smoke result for behavior that depends on Tauri.
- Produce the final diff, actual check evidence, known limitations and an Analyst verdict linked to the original task. This brief itself does not claim the pilot passed.
