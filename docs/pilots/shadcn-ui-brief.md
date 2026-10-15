# Deszo development pilot: shadcn/ui migration

Status: agreed business input and role assignments; workflow execution and UI migration are pending.

## Business task

Move all Deszo application panels, forms and dialogs to shadcn/ui. Preserve the current capabilities and workflow behavior, including React Flow editing, execution controls, recovery, history, Replay, Context chat and API/MCP authoring synchronization. Use the existing English product language.

The result is a separate local feature branch, `codex/shadcn-ui`, with the UI changes, relevant tests and documentation. Its starting point must include the verified explicit-effort change. Record the starting commit and the selected candidate before applying results. Merge and release remain separate actions.

## Roles

| Role | Provider | Model ID | Effort | Responsibility |
| --- | --- | --- | --- | --- |
| Analyst | Codex | `gpt-6.1-sol` | `max` | Receives the original business task first; writes requirements, acceptance scenarios and the implementation map; decides changes to requirement meaning; checks the complete business task at the end. |
| Developer reviewer | Claude Code | `claude-opus-5-5` | `medium` | Checks requirements for implementation and testability, reviews test coverage and code, and routes actionable defects to their owners. |
| Test author | Claude Code | `claude-haiku-5-5` | `xhigh` | Writes tests against approved requirements and interfaces, then repairs test defects. |
| Developer | Claude Code | `claude-haiku-5-5` | `xhigh` | Implements bounded tasks and repairs code defects. |
| Junior analyst | Codex | `gpt-6-luna` | `max` | Applies scoped documentation corrections and maintains examples and references. Changes to requirement meaning go back to the Analyst. |

The user confirmed `xhigh` for both Haiku roles and `max` for Luna. Each executor and reviewer has a separate Context and task directory. Model access is checked before the first real pilot invocation; the names in this brief are not evidence of account access.

## Preparation and execution

1. The Analyst inspects the current UI and records an inventory of panels, forms, dialogs and application-owned controls, then produces `SPEC.md`, `spec-index.json` and `implementation-map.json`.
2. The developer reviewer checks completeness, interface preservation, implementation feasibility and testability. The junior analyst applies documentation corrections; substantive decisions return to the Analyst. Recheck the affected requirements before implementation.
3. Pin the approved specification and project snapshot. The test author and developer work from the approved interfaces in separate task directories. Shared dependencies and files must have an explicit order or a single owner in the implementation map.
4. Assemble the selected task results and run the approved checks on that exact candidate. Reviewer findings return to the responsible executor. Bound repair cycles and pause on an unknown cause.
5. Update the documentation, complete technical review, and let the Analyst check the original business task against the assembled result and actual evidence. Apply the accepted candidate to the feature branch with a recorded diff and rerun the relevant checks there.

The stable Deszo installation controls the pilot. Development/runtime previews use separate data directories. Prepare Node dependencies and approved temporary/report paths in task/check directories before verification; the small reference delivery example does not establish this setup for the full Deszo repository.

## Acceptance scope

- The UI inventory covers the palette and application toolbar; workflow overview and node inspector; Map role editor and navigator; run, issue and Context panels; recovery controls; history and Replay; settings, workspace and workflow dialogs; external-run confirmation and Context chat.
- Application-owned buttons, inputs, selectors, dialogs, tabs and status surfaces use the agreed shadcn/ui components and shared theme tokens. Keep the React Flow canvas, port connections, selection, zoom/pan and nested navigation functional.
- Preserve save/load, validation, dirty-state handling, editor synchronization, run/stop/retry, task limits, Context behavior and all current configuration options, including reasoning effort.
- Verify keyboard navigation, labels, visible focus, dialog focus handling, disabled/busy states, error states and small-window overflow on the affected surfaces.
- Run the frontend build, appropriate runtime/contract regression checks and documentation checks. Add meaningful UI interaction coverage for the changed flows using the fixture runtime. Record browser screenshots and a desktop smoke result for behavior that depends on Tauri.
- Produce the final diff, actual check evidence, known limitations and an Analyst verdict linked to the original task. This brief itself does not claim the pilot passed.
