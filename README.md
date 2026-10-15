# Deszo

A personal desktop application for building workflows across AI agents. It uses Tauri 2, React and React Flow, and drives the official subscription-authenticated CLIs for Codex, Claude Code and Antigravity.

**Status:** milestones M1–M6, the reference Delivery Loop, and ADR-0001 external authoring are implemented. API v3 conditional saves, editor synchronization, scoped credentials, approval-gated execution, and the shared MCP bridge passed acceptance with the listed Windows Codex, Claude Code, and Antigravity versions. Confirmation defaults to on; v2 workflow saves return `410`. See the [acceptance report](docs/pilots/2026-10-15-authoring-acceptance.md), [implementation status](docs/adr/0001-implementation-status.md), and [migration note](docs/authoring/MIGRATION_V3.md).

## What M1 does

- An editable canvas with five node types: Text, Prompt Template, Agent (Codex / Claude Code / Antigravity), Context and Result Viewer. Typed ports, Context reference links and order-only After links are drawn distinctly.
- Canonical `core-v1` workflow JSON, validated structurally ([schema](docs/schemas/workflow.schema.json)) and semantically. Validation covers cycles, unordered shared Contexts, slot/marker mismatch, port types and timeouts.
- A durable run journal for every run in SQLite. Events, inputs, invocations, log batches and outputs are content-addressed objects, and their digests are verified on every read.
- A scheduler with application-wide capacity (3 calls overall and 1 per provider by default, editable), one writer per native session and per working directory, atomic resource acquisition, and draining after the first failure.
- Context bindings: **New per run**, or **Continue** with an exact binding; there is no silent fresh-session fallback. Interrupted or failed native writes put a binding into `needs_review` until you accept its state.
- Root Stop, active-process timeouts, typed failures (authentication, quota, billing policy, timeout, output contract, …), and restart recovery that never retries a model call automatically.
- Desktop process containment: the Rust supervisor places the runtime in a Windows Job Object, so closing or crashing the app also terminates every CLI the runtime started.

## What M2 adds

- **Loops** (`loops-v1`): a post-check Loop container with a body edited on its own canvas. Loop Input supplies the value, iteration, feedback and fixed inputs; Loop Return takes the candidate and a decision `{continue, reason, feedback}` from a Condition or a JSON Agent checker. JsonValue state is validated against a schema, and iteration and active-time limits pause the loop instead of passing it.
- **Data utilities**: File / Artifact Input (workspace snapshots or a pinned artifact), Merge (text, file sets without overwrites, or a JSON record), JSON Select and Condition. Agents can attach a file set and capture declared output files.
- **Recovery**: a failure drains the run and then waits for you. You can retry a node (accepting its conversation's state or starting a fresh one), raise a loop's limits, restart an iteration, or close the run. A scoped Stop stops one node or one loop.
- **Replay**: a read-only Next / Prev view of any saved run, including each loop iteration, built from the journal alone.
- API v2, journal v2 and database migration 2 (with an automatic backup of an M1 store).

## Run on Windows

Requirements: Node.js 22+ (the runtime uses the built-in `node:sqlite`), Rust, MSVC C++ Build Tools, the Windows SDK and WebView2.

```powershell
npm.cmd install
npm.cmd run desktop
```

Install the official CLIs and sign in with their subscription accounts:

```powershell
codex login
claude auth login
agy
```

On first start, create a workspace. Leave the directory empty for a managed scratch folder, or choose a project folder. Agents run in that directory with Full Access. Every Agent needs an explicit model ID; models are never substituted.

### Browser development

```powershell
npm.cmd run runner           # standalone runtime with real CLIs
npm.cmd run runner:fixtures  # or: deterministic fixture CLIs, no quota used
npm.cmd run dev              # then open http://127.0.0.1:1420
```

With the fixture runtime, model IDs select scenarios: `fixture-echo`, `fixture-slow-5`, `fixture-fail`, `fixture-bad-json`, `fixture-quota`, `fixture-noisy`. The standalone runner reports `standalone-best-effort` containment. Only the desktop app provides the Job Object guarantee.

## Data

Development data lives in `.deszo/` in the project; release builds use the local application-data folder for `local.deszo.app`.

```text
<root>/store/state.sqlite        # runs, attempts, journal, bindings, settings
<root>/store/objects/<sha256>    # immutable, digest-verified artifacts
<root>/workdirs/scratch/<id>/    # managed workspace folders (siblings of the store)
<root>/runtime/                  # connection file, lock, runtime log
```

Official CLIs keep their native conversations in their own storage. The application's journal records what it observed. It is not a copy of provider-internal context.

## Commands

```powershell
npm.cmd test            # contract fixtures + engine tests with fixture CLIs (no model calls)
npm.cmd run docs:check  # documentation/schema consistency (needs Python 3.11 + jsonschema)
npm.cmd run build       # type-check and build the frontend
npm.cmd run desktop:build   # bundle the runtime and build a release executable
npm.cmd run smoke -- --codex <model-id> --claude <model-id>
```

`smoke` runs the documented Codex → Claude → Codex chain against the real CLIs and **consumes subscription quota**. Each invocation uses a fresh isolated root; `--root` can select an explicit unused evidence directory. Only one runtime may own a data folder.

## Source layout

- `src/`: React editor, inspector, run journal, history and Context views.
- `runtime/core/`: canonical JSON, schemas, validator, store, adapters, process control and the engine.
- `runtime/runner.mjs`: authenticated loopback HTTP/SSE APIs (`/api/v2` and authoring `/api/v3`).
- `mcp/bridge.mjs`: shared stdio MCP bridge for Codex, Claude Code and Antigravity; setup is generated in Deszo Settings (see [authoring bridge setup](docs/authoring/README.md)).
- `src-tauri/src/main.rs`: runtime supervision, Job Object containment and Tauri IPC.
- `docs/`: specifications, schemas, reference SQL and fixtures. The runtime loads the schemas and DDL directly from here.

Official references: [Codex CLI](https://learn.chatgpt.com/docs/cli/reference), [Tauri](https://v2.tauri.app/develop/calling-frontend/), [Claude Code](https://code.claude.com/docs/en/headless) and [Antigravity CLI](https://antigravity.google/docs/cli/headless/).
