# Product Specification

Version: 0.7  
Status: confirmed interaction direction with proposed UX  
Updated: 2026-10-13

A personal desktop tool for connecting AI tasks, reusable conversations, and deterministic utilities on an Orange-inspired canvas. This document owns user interactions. Execution rules live in [M1 contracts](M1_CONTRACTS.md), [Loops](LOOPS.md), and [Map](IMPLEMENTATION_MAP.md).

## Workspace

A workspace contains workflows and an explicit project or scratch-directory binding. The main layout has a node palette, React Flow canvas, docked inspector, and run/history panel. Nodes expose typed ports; the inspector edits configuration and shows resolved inputs/output provenance. Creating an edge validates port compatibility immediately.

Prompt text is data: add Text, type the request, and connect it to an Agent's prompt input. Prompt Template supplies named inputs for combining responses and instructions. Do not put a second hidden task prompt in Agent settings.

The current editable draft stays separate from captured runs. Save/load uses canonical workflow JSON. Show draft validation errors and disable Run until the definition is executable. Moving/renaming cards changes presentation. During a run, show the captured version and clearly indicate when the editor has newer semantic changes.

## Palette delivery

| Milestone | Added palette types |
| --- | --- |
| M1 | Text, Prompt Template, Agent, Context, Result Viewer |
| M2 | File/Artifact Input, Merge, JSON Select, Condition, Loop |
| M3 | Cache |
| M4 | Gate, Route; selected mode in Merge, nesting in Loop |
| M5 | Implementation Map, Assemble, Test Runner |

These are sixteen target palette types. Task Input/Return and Loop Input/Return are container boundaries rather than additional palette types. Provider choice is an Agent setting/preset; distinct provider cards share the Agent contract.

## Context connections

Context has a separate visual reference connection to compatible Agent nodes. Display provider, New/Continue mode, binding state, cwd, and known native-session details. An Agent may run without Context and start a fresh conversation.

For Text → Codex → Claude → Codex, connect both Codex nodes to one Codex Context and Claude to another. The first Codex answer goes to Claude; Claude's answer goes to the second Codex prompt. The final Codex call retains its own previous conversation through Context.

Show ordering conflicts before a run. A missing Continue session offers explicit rebinding or New, with no automatic choice. Native history may include turns outside this workflow; do not label an old run snapshot as a rewindable conversation.

M3 adds a docked Context chat. It displays busy locks and uncertain-state warnings and uses the normal execution/journal path. Manual chat is not an invisible injected scheduled turn.

## Run inspection and control

Run shows active/waiting/succeeded/failed nodes, selected provider/model, attempt identity, elapsed active time, and input/output links. Stop visibly remains Stopping until process trees exit. A negative review or failed test report gets its own judgment display, distinct from a broken CLI invocation.

M2 exposes scoped Stop/Retry and Loop iteration controls. Limits and ambiguous recovery show a paused scope with the reason; the user can explicitly retry, raise a limit, restart with new bindings, or cancel. Structured issue/candidate data remains inspectable.

Cache is a standalone checkpoint. Live runs its producer; Frozen shows the pinned source run/value and feeds that value downstream. Refresh visibly replaces the pin after a successful capture. Do not present Frozen as restored tool/filesystem/native-session state.

## History and Replay

Every run appears in history with captured workflow identity, outcome, and inspectable evidence. M2 opens a separate read-only captured canvas with Next/Prev. It retains the editor draft and never executes tools or rewrites files. Parallel progress follows journal sequence.

M5 opens the Implementation Map as a graph/list progress navigator while a map executes. It shows accepted/total, running/waiting/blockers, task dependencies, current selections, attempts, criteria, and snapshot/check links. Draft documentation shows a plan preview rather than implementation progress.

M6 adds historical generated-task canvases and carry-forward provenance. A completed map still displays the surrounding pipeline's final-review/Customer stage; map progress is not final business acceptance.

## Language and settings

Product-authored labels, descriptions, prompts, and error messages use English. User text and provider responses stay unchanged.

Show explicit provider/model, native configuration profile, tool access and Agent timeout. Application Settings exposes concurrency limits shared across every workspace. Defaults and compatibility rules are owned by [M1 contracts](M1_CONTRACTS.md). Inherit is a visible native-configuration option, with invocation-level provenance.

The first user release includes single-level loops at M2. Full delivery-pipeline operation arrives in stages described by [MILESTONES.md](MILESTONES.md).
