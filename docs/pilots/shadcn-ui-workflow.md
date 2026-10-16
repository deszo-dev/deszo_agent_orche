# shadcn/ui pilot workflow

Status: role configuration prepared; execution and source-snapshot refresh remain pending.

The [business brief](shadcn-ui-brief.md) owns the scope and role assignments. The generated [workflow](shadcn-ui-workflow.json) is based on the engine's reference Delivery Loop, with every provider/model/effort explicit. Its workspace is `deszo-development`, bound to this repository on `codex/shadcn-ui`.

## Execution stages

1. Capture the repository base as immutable artifacts. Record its starting commit and file hashes.
2. The senior Analyst (`gpt-6.1-sol`, `max`) receives the business task first and writes the initial requirements, UI inventory, acceptance scenarios, section index and implementation map.
3. The junior Analyst (`gpt-6-luna`, `max`) corrects documentation structure, references and declarations while preserving the senior's decisions. Independent Code and Test reviewers (each `claude-opus-5-5`, `medium`) check implementation readiness and testability respectively, using separate Contexts. Both must approve the same bundle. Rejection returns to the senior Analyst; the authoring loop has three iterations.
4. The approved Implementation Map dispatches code and tests to separate `claude-haiku-5-5`, `xhigh` task roles. The junior Analyst owns a dependent implementation-documentation task. `code-reviewer` reviews implementation/documentation results; `test-reviewer` reviews tests and UI evidence. Mixed code/test tasks require both review criteria. Each reviewer uses its own task Context and directory. Shared files need an ordered owner. Task capture supports create/replace operations for this pilot; plan module splits without deleting base files.
5. A dependent test-author task runs the [wrapper](../../scripts/shadcn-pilot-check.mjs) in UI-only mode against all accepted UI/test outputs and captures a report plus main, dialog and small-window PNG screenshots as reviewed artifacts. Then assemble all accepted outputs and execute the approved full candidate check. The wrapper runs `npm ci`, frontend build, runtime regressions, documentation checks, the required `test:ui` script and runtime bundling in one fresh directory. Dependencies and build/scratch paths are never deliverables; the explicitly declared UI evidence is retained.
6. The Code and Test reviewers independently perform final technical review of the complete candidate. Both Opus decisions are required before the senior Analyst checks the original business task against the complete automated evidence. Failures route to task repair or specification revision; unknown causes pause. Limits are three task attempts, three failed verification cycles and three outer delivery iterations.
7. The operator applies the selected candidate to the feature branch, records the diff and reruns relevant checks, including a desktop smoke against the built Tauri app. Workflow acceptance covers the captured automated candidate; it does not claim this final desktop check, merge or release happened.

## Preparation

Run `node scripts/prepare-shadcn-pilot.mjs` from the feature branch before saving a new workflow revision. The script validates the graph and writes the source manifest, read-only document validator and preparation record below `.deszo/pilots/shadcn-ui`. It neither starts a run nor calls a model. Regenerate after any intentional source change before execution, then validate and save the new workflow snapshot.

The [reviewer-role helper](../../scripts/shadcn-pilot-reviewers.mjs) applies the same split to existing drafts and new preparations. A role-only draft update does not refresh the source manifest or certify that the supervision work is complete. Reprepare from the stable source after the ADR-0002 delivery gates have passed.

The source manifest includes the local preparation tooling. Authoring agents may write only the three root specification files. Their validator rejects changes to the pinned project files. Ordinary Agent scope is instruction-based; task/check copies are separate directories and write scopes are validated by the engine.

The foundation task must add real browser-test setup and `test:ui`; the test author implements meaningful fixture-runtime interaction coverage and screenshot evidence. The script honors `DESZO_UI_EVIDENCE_DIR` and writes `report.json` with `schemaVersion: 1`, nonempty `scenarios` entries (`id`, `status: "passed"`) and `screenshots` naming `main.png`, `dialogs.png`, `small-window.png`. The wrapper checks the report and PNG signatures; the reviewer judges coverage and visual behavior. It intentionally fails if `test:ui` is absent. `docs:check` requires the repository's documented Python/jsonschema environment. Candidate checks are bounded to 600 seconds, including setup; an environment timeout is a recovery issue, not a passing test.

Model IDs and CLI availability do not establish subscription access. Verify the first real invocation of each assigned model/effort without silent fallback. Stop on authentication, model or effort errors and preserve the evidence.
