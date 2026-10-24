# Deszo Fixer workflow

Status on 2026-10-21: registered as revision 1, snapshot `e9a59fb978c566e2f182e9905004acc014966ff37f849187312161ecde51ec76`. A real Developer preflight report was produced; the Watcher failed its finish contract and the Judge canceled that run. No successful end-to-end Fixer handoff is claimed. The repaired controller's live MCP connection and complete tool set are verified in the [control review](../reviews/2026-10-21-deszo-control-review.md). ADR-0006 acceptance and production autonomy remain open.

Importable workflow: [fixer-workflow.json](fixer-workflow.json). Workflow ID: `deszo-fixer`. The graph uses existing `core-v1` and `loops-v1` nodes and adds no service or Judge process. Operational runtime fixes are documented separately in the control review.

Proposed attention contract: [ADR-0007](../adr/0007-event-driven-judge-attention-and-compact-evidence.md) moves routine supervision away from Judge model polling and defines durable event-driven requests with compact evidence. It is not implemented and does not change this saved workflow or its current supervision grants.

Its first implementation prefers an explicitly registered dedicated Judge session; the interactive-chat configuration requires separately verified user-turn exclusion. This chat remains the current Judge until an explicit registration/ownership transfer. Diagnostic budget checkpoints do not themselves require Judge calls under the proposed default policy. See the [final amendment resolution](../reviews/2026-10-21-adr-0007-second-review-resolution.md).

| Participant | Placement | Provider / model | Explicit effort |
| --- | --- | --- | --- |
| Judge | This external Codex chat; never an Agent node | Codex / gpt-6.1-sol | max |
| Developer | Agent inside the loop | Claude Code / claude-haiku-5-5 | xhigh |
| Watcher | Agent inside the loop | Antigravity / gemini-3.8-flash-high | high |

The saved bindings implement the user's requested roles. Local validation and fixture execution do not prove that the installed provider CLIs currently accept these exact model/effort combinations. Verify the selected runtime capabilities before real execution; do not substitute a model or effort.

The Judge sets `fixer-judge-task.config.value`. The Developer performs one bounded step and returns a structured report. The Watcher reads the exact brief, the previous checkpoint and the report. Its verdict drives the existing Condition node:

- `CONTINUE`: one concrete next action and expected evidence; the feedback reaches the next Developer turn.
- `ESCALATE`: finish this execution with a problem/evidence package for the external chat.
- `READY_FOR_REVIEW`: finish with a result awaiting the Judge.
- `BLOCKED`: finish with a durable external prerequisite.

The engine derives the loop boolean from `outcome`; there is no separately model-authored boolean that can contradict the verdict. The Developer uses a Context shared within the run. The Watcher gets a fresh Context each iteration and the explicit prior checkpoint. A subsequent run does not silently inherit native Context.

The hard engine limits are three iterations and 45 active minutes; Developer timeout is 600 seconds and Watcher timeout is 300 seconds. These are orchestration bounds, not an authorization grant or a guarantee of six total billable calls across recovery. Every actual invocation and recovery must remain inside its applicable aggregate limits. The Watcher is instructed to escalate repeated unchanged failure. That semantic instruction is not a deterministic proof of progress; the engine's iteration/time limits provide the hard bound. A timeout, invalid output or exhausted loop may produce `waiting_for_user`; the Judge inspects that checkpoint instead of assuming successful repair.

A normal terminal result is `FixerHandoff` with `acceptance=PENDING_EXTERNAL_JUDGE`. An execution marked `succeeded` means it produced the handoff, including escalation or blockage. It does not establish fixed behavior, an accepted candidate, ADR closure, a commit, or `READY_FOR_MERGE`.

The first captured brief is `ADR6-PREFLIGHT-001`: read-only reconciliation of the remaining engineering and a proposal for one bounded next implementation task. It prevents starting with a broad instruction to finish all ADRs at once. It permits no source writes, provider subprocesses, lifecycle work, authentication or deployment. Use a captured isolated workspace containing the relevant current dirty source and explicit permitted inputs; a clean HEAD-only checkout would omit the existing implementation. Include the selected checkpoint as an explicit input if required. Do not assume ignored `.deszo` files exist in another checkout.

For later implementation tasks the Judge records the exact task ID, source identity, allowed files/actions, acceptance criteria, checks, prior report and any changed approach in a new brief. Save its revision using the current ETag and stable request ID. The existing execution MCP API does not expose arbitrary task entry inputs, so do not claim that changing a local task file changes a saved snapshot. Re-evaluate workflow revision coverage and exact run grants before dispatch.

The graph uses ordinary Agent nodes working in their selected workspace. It does not itself add filesystem isolation, managed-task candidate assembly, engine-run checks or independent review certificates. Prompt restrictions are not OS enforcement. Those protections come from the selected workspace, existing host/supervision policy and applicable engine stages. Keep protected installation maintenance separate from source changes, and do not run concurrently against files another implementation is changing.

To use this while ADR-0006 is unfinished:

1. Follow the [Deszo Control skill](../../skills/deszo-control/SKILL.md) for preflight and connection. Verify `get_authoring_contract` identifies the intended controller and store. Do not start a candidate runtime with unrestricted credentials to bypass the host.
2. Read `deszo-fixer` before saving. If absent, use create-only `put_workflow` with `expectedEtag:null`; if present, compare content and use its actual ETag. Do not overwrite an unrelated existing workflow.
3. Validate through that runtime, inspect capabilities, and select/register the intended workspace.
4. Obtain and verify the exact applicable supervised run authority and client timing profile. The old diagnostic policy is expired and had no provider authority. This workflow does not enable bootstrap-host provider dispatch. Ordinary supported manual supervised execution and production autonomous execution retain their distinct authorization requirements.
5. Read the existing preflight report and incident evidence rather than repeating repository discovery. Its canceled execution is not an accepted handoff. The external Judge assigns the next bounded task with captured current inputs. If the runtime disappears, preserve the checkpoint and use existing authorized recovery or human intervention.

Continue ADR-0006 engineering first; then assign ADR-0003 through ADR-0005 work explicitly. The Fixer loop does not remove their required independent reviews, business acceptance, native checks, security-critical promotion rules or verified local delivery. The saved feature workflow and its previously unapproved revisions remain unchanged.

Initial local fixture verification used temporary runtimes and deterministic fake responses, with the production graph's model/effort bindings intact:

- A routine continuation reaches the next iteration and returns `READY_FOR_REVIEW`.
- `ESCALATE` and `BLOCKED` produce pending-Judge handoffs.
- Perpetual continuation pauses at three iterations.
- A malformed Watcher verdict pauses rather than inventing a successful decision.

All five fixture scenarios passed; structural/semantic validation and native transport-schema checks passed. That fixture phase invoked no real provider. The later real preflight and its cancellation are summarized above. The local harness and qualified evidence are in `.deszo/pilots/fixer/2026-10-21/`. Fixture evidence alone does not prove real provider availability, native lifecycle behavior or end-to-end feature acceptance.
